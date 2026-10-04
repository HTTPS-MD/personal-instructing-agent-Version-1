-- STUB of the live-only objects (not the real database)
do $$ begin
  if not exists (select 1 from pg_roles where rolname='anon') then create role anon nologin; end if;
  if not exists (select 1 from pg_roles where rolname='authenticated') then create role authenticated nologin; end if;
  if not exists (select 1 from pg_roles where rolname='service_role') then create role service_role nologin; end if;
end $$;
create schema if not exists auth;
create table auth.users (id uuid primary key default gen_random_uuid(), email text);
create function auth.jwt() returns jsonb language sql stable as $$ select coalesce(nullif(current_setting('request.jwt.claims', true),''),'{}')::jsonb $$;
grant usage on schema auth, public to anon, authenticated, service_role;
create table public.profiles (
  email text primary key, full_name text, role text default 'student', group_type text, section text,
  is_ocean_done boolean default false, selected_character text, current_stage text, stage_started_at timestamptz,
  is_in_game boolean default false, current_problem int, current_difficulty text, hints_used int, consecutive_correct int,
  status text, active_devices jsonb, parental_consent boolean, student_assent boolean, max_devices int default 1,
  pre_test_score numeric, post_test_score numeric, last_seen timestamptz, updated_at timestamptz default now());
grant select, insert, update, delete on public.profiles to authenticated;
create function public.jwt_is_current() returns boolean language sql stable as $$ select true $$;
create function public.pia_stage_open(k text) returns boolean language sql stable as $$ select true $$;
create function public.submit_ocean_results(p_responses integer[]) returns jsonb language sql as $$ select '{}'::jsonb $$;
create table public.tutoring_attempts (
  session_id uuid not null, student_email text not null, problem_id text not null, problem_number int not null,
  level_before int, level_after int, attempts_used int, hints_used int, time_taken_ms bigint, is_correct boolean,
  classification text check (classification in ('smooth','struggling')),
  primary key (session_id, problem_number));
create function public.start_game_session() returns uuid language plpgsql security definer as $$ begin return gen_random_uuid(); end $$;
create function public.end_game_session(p_session_id uuid) returns void language sql as $$ select $$;
-- teacher_class_status stub carrying the anchor 0029 edits
create function public.teacher_class_status() returns int language plpgsql as $$
declare v_session uuid; begin return (select max(h.consumed_at) from public.hint_consumptions h where h.session_id = v_session); end $$;
