-- ============================================================================
-- STAGING-ONLY BOOTSTRAP for the game + ML flow.  NEVER RUN ON PRODUCTION.
-- ============================================================================
-- WHY THIS EXISTS. The repo's migrations assume a database that already holds
-- objects created by hand in the production dashboard (profiles, tutoring_attempts,
-- start_game_session, ...). A fresh Supabase project does not have them, so the
-- migrations cannot run. This file creates MINIMAL STAND-INS for exactly the
-- objects the game chain needs, so the game and the ML flow can be exercised with
-- SYNTHETIC data on a staging project.
--
-- EVERYTHING BELOW IS A PLACEHOLDER. It is copied from supabase/scratch/
-- stub_live_only_objects.sql, not from the production schema (which was not read).
-- It therefore does NOT prove the migrations are compatible with production:
--   * profiles: columns are the ones the game chain touches; production's real
--     columns, constraints, policies and triggers are unknown.
--   * tutoring_attempts: the columns the migrations INSERT into / read.
--   * jwt_is_current / pia_stage_open / submit_ocean_results / start_game_session /
--     end_game_session / teacher_class_status: simplified behaviour, NOT the real
--     functions (e.g. jwt_is_current only checks that the token has an email, it does
--     not check for revoked sessions).
-- Production compatibility is only proven by supabase/PREFLIGHT_0039_readonly.sql
-- run against production by its owner.
--
-- APPLY ORDER (after this file), each as its own run in the SQL Editor:
--   20260822_0001, 0004, 0005, 20260929_0028, 0029, 20260930_0038, 20261003_0039,
--   20261004_0044     (0041-0043 are admin/OCEAN extras, not needed for the ML flow)
-- ============================================================================
begin;

-- Safety: refuse to run anywhere that holds data or already looks like PIA.
do $$
begin
  if to_regclass('public.profiles') is not null then
    if exists (select 1 from information_schema.columns
                where table_schema = 'public' and table_name = 'profiles' and column_name = 'email') then
      raise exception 'STAGING BOOTSTRAP ABORT: public.profiles already has an email column (this looks like a PIA database). Nothing changed.';
    end if;
    if (select count(*) from public.profiles) > 0 then
      raise exception 'STAGING BOOTSTRAP ABORT: public.profiles holds rows. Nothing changed.';
    end if;
  end if;
  if to_regclass('public.tutoring_attempts') is not null or to_regclass('public.step_events') is not null then
    raise exception 'STAGING BOOTSTRAP ABORT: game tables already exist. Nothing changed.';
  end if;
end;
$$;

-- DESTRUCTIVE (staging only, guarded above): the staging project's existing
-- public.profiles is a different, EMPTY table (id uuid, lrn, is_activated,
-- full_name). It has no email column, which every PIA migration needs.
drop table if exists public.profiles cascade;

-- PLACEHOLDER: the PIA profiles table (columns the game chain touches).
create table public.profiles (
  email text primary key, full_name text, role text default 'student', group_type text, section text,
  is_ocean_done boolean default false, selected_character text, current_stage text, stage_started_at timestamptz,
  is_in_game boolean default false, current_problem int, current_difficulty text, hints_used int, consecutive_correct int,
  status text, active_devices jsonb, parental_consent boolean, student_assent boolean, max_devices int default 1,
  pre_test_score numeric, post_test_score numeric, last_seen timestamptz, updated_at timestamptz default now());
revoke all on public.profiles from anon;
grant select, insert, update, delete on public.profiles to authenticated;

-- PLACEHOLDER: tutoring_attempts (columns used by 0004/0029/0039/0042/0043).
create table public.tutoring_attempts (
  session_id uuid not null, student_email text not null, problem_id text not null, problem_number int not null,
  level_before int, level_after int, attempts_used int, hints_used int, time_taken_ms bigint, is_correct boolean,
  classification text check (classification in ('smooth','struggling')),
  primary key (session_id, problem_number));
revoke all on public.tutoring_attempts from anon, authenticated;

-- PLACEHOLDER functions (simplified; see the header).
create function public.jwt_is_current() returns boolean language sql stable
  as $$ select (auth.jwt() ->> 'email') is not null $$;
create function public.pia_stage_open(k text) returns boolean language sql stable as $$ select true $$;
create function public.submit_ocean_results(p_responses integer[]) returns jsonb language sql as $$ select '{}'::jsonb $$;
create function public.start_game_session() returns uuid language plpgsql security definer as $$ begin return gen_random_uuid(); end $$;
create function public.end_game_session(p_session_id uuid) returns void language sql as $$ select $$;
create function public.teacher_class_status() returns int language plpgsql as $$
declare v_session uuid; begin return (select max(h.consumed_at) from public.hint_consumptions h where h.session_id = v_session); end $$;
revoke all on function public.start_game_session(), public.end_game_session(uuid), public.teacher_class_status() from public, anon;
grant execute on function public.start_game_session(), public.end_game_session(uuid) to authenticated;

commit;
