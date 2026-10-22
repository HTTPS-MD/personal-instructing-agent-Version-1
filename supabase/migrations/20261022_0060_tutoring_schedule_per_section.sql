-- PIA 0060: the Tutoring opens and closes per section, on a schedule the admin sets.
--
-- WHY. Until now two things decided whether a student could play: the stage switch of the
-- section (admin_grant_stage / admin_revoke_stage) and ONE closing time for everybody
-- (app_config.game_closes_at, 0045). The switch could say "open" while the closing time had
-- already passed, so students were locked out and the admin could not tell why. Now the
-- closing time belongs to the section, next to its switch, and may also have a start.
--
-- RULE. For a student of section S, the tutoring is CLOSED when S has a schedule row and
--   now() < opens_at   (not open yet), or
--   now() >= closes_at (closed).
-- No row, or a NULL side, means that side is not limited. Entry still needs the stage switch
-- (stage_overrides); the schedule only adds the time window. It is enforced where 0045
-- enforced it: answers and hints are refused, so it holds whether the student stays, quits
-- or comes back. Nothing needs to run at the start or end time: it is judged at each call.
--
-- STATE KEPT. Every section that had a student gets the old global closing time as its own
-- closing time, so what is closed today stays closed and what is open stays open.
-- app_config.game_closes_at stays in the table but is no longer read.
-- NO game record is changed or deleted. Nothing is applied by this file being in the repo.
begin;

do $$
begin
  if to_regprocedure('public.pia_tutoring_closed()') is null
     or to_regprocedure('public.tutoring_status()') is null
     or to_regprocedure('public.pia_caller_role()') is null
     or to_regprocedure('public.jwt_is_current()') is null then
    raise exception 'PIA 0060 ABORT (nothing changed): apply 0045/0048 (and the auth helpers) first.' using errcode = 'P0001';
  end if;
end;
$$;

-- ---------------------------------------------------------------------------
-- 1. The schedule, one row per section
-- ---------------------------------------------------------------------------
create table if not exists public.tutoring_schedule (
  section    text primary key,
  opens_at   timestamptz,
  closes_at  timestamptz,
  set_by     text,
  set_at     timestamptz not null default now(),
  check (opens_at is not null or closes_at is not null),
  check (opens_at is null or closes_at is null or closes_at > opens_at)
);

alter table public.tutoring_schedule enable row level security;
revoke all on public.tutoring_schedule from public, anon, authenticated;
grant select on public.tutoring_schedule to authenticated;

drop policy if exists tutoring_schedule_admin_read on public.tutoring_schedule;
create policy tutoring_schedule_admin_read on public.tutoring_schedule
  for select to authenticated
  using (public.pia_caller_role() = 'admin' and public.jwt_is_current());

comment on table public.tutoring_schedule is
  'When the Tutoring is open for a section (0060). No row = not limited by time. Replaces app_config.game_closes_at.';

-- The old global closing time becomes each section''s own, so no state changes.
insert into public.tutoring_schedule (section, opens_at, closes_at, set_by)
select s.section, null, c.game_closes_at, 'migration 0060'
  from (select distinct nullif(trim(p.section), '') as section
          from public.profiles p
         where lower(trim(coalesce(p.role, 'student'))) = 'student') s
  cross join (select game_closes_at from public.app_config where id = 1) c
 where s.section is not null and c.game_closes_at is not null
on conflict (section) do nothing;

-- ---------------------------------------------------------------------------
-- 2. The question every student function already asks, now per student
-- ---------------------------------------------------------------------------
create or replace function public.pia_tutoring_closed_for(p_email text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce((
    select (t.opens_at is not null and t.opens_at > now())
        or (t.closes_at is not null and t.closes_at <= now())
      from public.profiles p
      join public.tutoring_schedule t on t.section = nullif(trim(p.section), '')
     where lower(p.email) = lower(p_email)
     limit 1), false);
$$;

-- The caller's own section. Same name and shape as in 0045, so every function that calls it
-- (answers, hints, restart) keeps working unchanged.
create or replace function public.pia_tutoring_closed()
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select public.pia_tutoring_closed_for(auth.jwt() ->> 'email');
$$;

create or replace function public.pia_window_expired(w public.game_windows)
returns boolean language sql stable as $$
  select public.pia_tutoring_closed_for(w.student_email);
$$;

create or replace function public.pia_clock_json(w public.game_windows)
returns jsonb language sql stable as $$
  select jsonb_build_object(
    'window',            w.window_no,
    'closed',            public.pia_tutoring_closed_for(w.student_email),
    'expired',           public.pia_tutoring_closed_for(w.student_email),
    'limit_seconds',     86400,
    'remaining_seconds', 86400);
$$;

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
  select t.closes_at into v_closes
    from public.profiles p
    join public.tutoring_schedule t on t.section = nullif(trim(p.section), '')
   where lower(p.email) = lower(p_email) limit 1;
  v_closed := public.pia_tutoring_closed_for(p_email);

  select * into w from public.game_windows
   where session_id = p_session_id and student_email = p_email
   order by window_no desc limit 1;

  if found then
    if w.ended_at is null and v_closed then
      update public.game_windows
         set ended_at = greatest(coalesce(v_closes, now()), w.started_at), ended_reason = 'closed'
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

-- For the start screen: closed or not, and whether it simply has not started. The seconds are
-- only for the page to lock or unlock at the exact moment; they are never drawn.
create or replace function public.tutoring_status()
returns jsonb
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text := public.pia_game_email();
  t       public.tutoring_schedule%rowtype;
begin
  select s.* into t
    from public.profiles p
    join public.tutoring_schedule s on s.section = nullif(trim(p.section), '')
   where lower(p.email) = lower(v_email) limit 1;

  return jsonb_build_object(
    'closed',            public.pia_tutoring_closed_for(v_email),
    'not_open_yet',      found and t.opens_at is not null and t.opens_at > now(),
    'seconds_to_open',   case when found and t.opens_at is not null and t.opens_at > now()
                              then ceil(extract(epoch from (t.opens_at - now())))::int end,
    'seconds_to_close',  case when found and t.closes_at is not null and t.closes_at > now()
                                   and not (t.opens_at is not null and t.opens_at > now())
                              then ceil(extract(epoch from (t.closes_at - now())))::int end);
end;
$$;

revoke all on function public.pia_tutoring_closed_for(text)             from public, anon, authenticated;
revoke all on function public.pia_tutoring_closed()                     from public, anon, authenticated;
revoke all on function public.pia_window_expired(public.game_windows)   from public, anon, authenticated;
revoke all on function public.pia_clock_json(public.game_windows)       from public, anon, authenticated;
revoke all on function public.pia_game_window(uuid, text)               from public, anon, authenticated;
revoke all on function public.tutoring_status()                         from public, anon;
grant execute on function public.tutoring_status()                      to authenticated;

-- ---------------------------------------------------------------------------
-- 3. The admin sets or clears a section's schedule
-- ---------------------------------------------------------------------------
-- p_opens / p_closes: either may be NULL (not limited on that side). Both NULL removes the
-- schedule. A closing time that is already past is refused: it would lock the section at once.
create or replace function public.admin_set_tutoring_schedule(
  p_section text, p_opens timestamptz, p_closes timestamptz)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_section text := nullif(trim(coalesce(p_section, '')), '');
begin
  if public.pia_caller_role() is distinct from 'admin' or not public.jwt_is_current() then
    raise exception 'PIA: only an administrator can set the tutoring schedule.' using errcode = '42501';
  end if;
  if v_section is null then
    raise exception 'PIA: choose a section.' using errcode = '22023';
  end if;
  if not exists (select 1 from public.profiles where nullif(trim(section), '') = v_section) then
    raise exception 'PIA: unknown section: %', v_section using errcode = '22023';
  end if;

  if p_opens is null and p_closes is null then
    delete from public.tutoring_schedule where section = v_section;
    return jsonb_build_object('section', v_section, 'opens_at', null, 'closes_at', null);
  end if;

  if p_closes is not null and p_closes <= now() then
    raise exception 'PIA: the end must be in the future.' using errcode = '22023';
  end if;
  if p_opens is not null and p_closes is not null and p_closes <= p_opens then
    raise exception 'PIA: the end must be after the start.' using errcode = '22023';
  end if;

  insert into public.tutoring_schedule (section, opens_at, closes_at, set_by, set_at)
  values (v_section, p_opens, p_closes, lower(nullif(auth.jwt() ->> 'email', '')), now())
  on conflict (section) do update
    set opens_at = excluded.opens_at, closes_at = excluded.closes_at,
        set_by = excluded.set_by, set_at = excluded.set_at;

  return jsonb_build_object('section', v_section, 'opens_at', p_opens, 'closes_at', p_closes);
end;
$$;

revoke all on function public.admin_set_tutoring_schedule(text, timestamptz, timestamptz) from public, anon;
grant execute on function public.admin_set_tutoring_schedule(text, timestamptz, timestamptz) to authenticated;

-- The admin screens see a change at once (row-level security still limits it to admins).
do $$
begin
  if exists (select 1 from pg_publication where pubname = 'supabase_realtime')
     and not exists (select 1 from pg_publication_tables where pubname = 'supabase_realtime'
                      and schemaname = 'public' and tablename = 'tutoring_schedule') then
    alter publication supabase_realtime add table public.tutoring_schedule;
  end if;
end;
$$;

commit;
