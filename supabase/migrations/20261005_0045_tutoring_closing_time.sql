-- PIA 0045: the tutoring closes at a time the admin sets (Philippine time in the admin
-- screen, stored as a timestamp with time zone). It replaces the per-session
-- "Game time limit (minutes)" of 0039.
--
-- RULE. app_config.game_closes_at is the one switch:
--   * NULL (never set)                  -> tutoring is open.
--   * now() >= game_closes_at           -> tutoring is CLOSED for everyone, enforced on the
--                                          server: answers and hints are refused whether the
--                                          student stays, quits, signs out or comes back.
--   * the admin sets a later time/NULL  -> it opens again; the student continues exactly
--                                          where they left off (no restart, no "try again").
-- The student sees no clock and no time at all; the page only learns "closed or not".
--
-- WHAT CHANGES. Only the window helpers and Try Again are redefined, so the big question and
-- answer functions of 0039 are untouched: they already stop on pia_window_expired().
--   pia_window_expired / pia_clock_json / pia_game_window / restart_after_expiry
-- and one new function, tutoring_status(), for the start screen. Old windows keep their
-- stored deadline but it is no longer consulted. app_config.time_limit and max_points stay
-- in the table, unused. No game record is changed or deleted.
begin;

do $$
begin
  if to_regclass('public.game_windows') is null or to_regclass('public.app_config') is null then
    raise exception 'PIA 0045 requires the 0039 game tables (apply 0039 first).';
  end if;
  if to_regprocedure('public.pia_game_email()') is null
     or to_regprocedure('public.serve_next_step_question(uuid)') is null then
    raise exception 'PIA 0045 requires the 0039 game functions (apply 0039 first).';
  end if;
end;
$$;

alter table public.app_config add column if not exists game_closes_at timestamptz;

create or replace function public.pia_tutoring_closed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((select c.game_closes_at <= now() from public.app_config c where c.id = 1), false);
$$;

-- A window is "expired" exactly when the tutoring is closed.
create or replace function public.pia_window_expired(w public.game_windows)
returns boolean language sql stable as $$
  select public.pia_tutoring_closed();
$$;

-- All the browser needs: closed or not. The numeric fields are legacy values so that a tab
-- still running the previous script keeps working until it is refreshed; nothing shows them.
create or replace function public.pia_clock_json(w public.game_windows)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'window',            w.window_no,
    'closed',            public.pia_tutoring_closed(),
    'expired',           public.pia_tutoring_closed(),
    'limit_seconds',     86400,
    'remaining_seconds', 86400);
$$;

-- The live window of a session. One window per open period: it ends when the tutoring
-- closes (ended_at = the closing time) and a new one starts if it is opened again.
create or replace function public.pia_game_window(p_session_id uuid, p_email text)
returns public.game_windows
language plpgsql
security definer
set search_path = public
as $$
declare
  w        public.game_windows%rowtype;
  v_closes timestamptz;
  v_closed boolean;
begin
  select c.game_closes_at into v_closes from public.app_config c where c.id = 1;
  v_closed := v_closes is not null and v_closes <= now();

  select * into w from public.game_windows
   where session_id = p_session_id and student_email = p_email
   order by window_no desc limit 1;

  if found then
    if w.ended_at is null and v_closed then
      update public.game_windows
         set ended_at = greatest(v_closes, w.started_at), ended_reason = 'closed'
       where session_id = w.session_id and student_email = w.student_email and window_no = w.window_no
       returning * into w;
      return w;
    end if;
    if w.ended_at is not null and not v_closed then
      insert into public.game_windows (session_id, student_email, window_no, limit_seconds, deadline_at)
      values (p_session_id, p_email, w.window_no + 1, 0, 'infinity')
      returning * into w;
    end if;
    return w;
  end if;

  insert into public.game_windows (session_id, student_email, window_no, limit_seconds, deadline_at)
  values (p_session_id, p_email, 1, 0, 'infinity')
  returning * into w;
  return w;
end;
$$;

-- "Try again" no longer exists as a restart. While closed it refuses; otherwise it just
-- serves the open question as it was left. Kept so an old tab does not error.
create or replace function public.restart_after_expiry(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text := public.pia_game_email();
begin
  if public.pia_tutoring_closed() then
    return jsonb_build_object('closed', true, 'restarted', false,
      'clock', jsonb_build_object('closed', true, 'expired', true, 'limit_seconds', 86400, 'remaining_seconds', 0));
  end if;
  return public.serve_next_step_question(p_session_id) || jsonb_build_object('restarted', false);
end;
$$;

-- For the start screen: closed or not, nothing else (no time).
create or replace function public.tutoring_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text := public.pia_game_email();
begin
  return jsonb_build_object('closed', public.pia_tutoring_closed());
end;
$$;

revoke all on function public.pia_tutoring_closed()                         from public, anon, authenticated;
revoke all on function public.pia_window_expired(public.game_windows)       from public, anon, authenticated;
revoke all on function public.pia_clock_json(public.game_windows)           from public, anon, authenticated;
revoke all on function public.pia_game_window(uuid, text)                   from public, anon, authenticated;
revoke all on function public.restart_after_expiry(uuid)                    from public, anon;
revoke all on function public.tutoring_status()                             from public, anon;
grant execute on function public.restart_after_expiry(uuid)                 to authenticated;
grant execute on function public.tutoring_status()                          to authenticated;

commit;
