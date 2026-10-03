-- ============================================================================
-- PIA 0039 -- THE STEP-BY-STEP GAME, CHECKED ON THE SERVER
-- ============================================================================
-- DRAFT FOR REVIEW. NOT APPLIED. Written without a database to run it against
-- (see "What was and was not verified" at the bottom). Read it, run it on a
-- staging copy first, then apply.
--
-- WHY
--   The attached game (pia-test-main) teaches Percentages one STEP at a time:
--   Topic 1 has 2 steps (Conversion, Multiplication); Topics 2 and 3 have 3
--   (Subtraction, Division, Conversion). 0029 serves the same question bank
--   but asks only for the final answer, with two tries. This migration brings
--   the game's own rules onto the server so the browser can show the new
--   screen without ever holding an answer.
--
-- THE GAME'S RULES, AS PORTED (from index.html in pia-test-main)
--   * A question has N steps. A step is solved when the student gives its
--     value. Wrong answers do not end the question: there is no try limit.
--   * Working is accepted but not final: "30 x 0.3" or "80/100" that evaluates
--     to the right value only opens a second box that asks for the value by
--     itself ("confirm" stage). Conversion steps need a decimal (Topic 1) or a
--     percentage (Topics 2-3), with or without the % sign.
--   * After two wrong answers on a step the hint button appears. Each step has
--     up to three hints (Concept, Setup, Worked calculation); each press moves
--     one tier up and the last tier repeats. The tier starts again on the next
--     step and when the confirm box opens.
--   * A question is "accurate" when it was finished with no wrong answer.
--   * Topic movement is OFFERED, never forced:
--       DOWN   after "Wrong to level down" (max_errors) questions in a row that
--              were not accurate, on Topic 2 or 3 -- checked first;
--       UP     after "Solved to level up" (min_questions) questions in this
--              topic with accuracy >= the mastery threshold, on Topic 1 or 2.
--     The student accepts or refuses. Accept: the new topic starts a fresh
--     window. Refuse after an UP offer: a fresh window on the same topic.
--     Refuse after a DOWN offer: the failure streak starts again at zero.
--     The numbers are the admin's (app_config), as in 0029.
--
-- WHAT STAYS ON THE SERVER (unchanged principle from 0029)
--   question_bank and served_questions have no student access. Every answer is
--   compared here; the browser receives right/wrong, the step the student is
--   on, and the student's OWN accepted values. A step's answer is never
--   returned, and a hint is only returned after two wrong answers.
--
-- WHO MAY ENTER (the research groups; group_type is the admin's and is never
-- read from the browser)
--   This migration does NOT redefine pia_can_enter_stage. The stage rule is
--   0038 (20260930_0038_control_ocean_only_neutral_persona.sql): Control is
--   refused the Tutoring Dashboard, free choice needs a saved tutor, and
--   assigned / legacy neutral may reach the dashboard with or without one.
--   Every game call below adds ONE condition on top of it: a saved tutor.
--     assigned / legacy neutral  the admin must have set selected_character.
--                                A missing tutor is never filled in.
--     non-assigned               the student has saved a tutor.
--     control / anything else    never (0038 for control; the group list
--                                below for unknown values) -- including a
--                                direct RPC call.
--
-- DEPARTURES FROM THE ATTACHED GAME, ON PURPOSE
--   * No per-session time limit and no timer. The game ended a session when a
--     countdown expired (app_config.time_limit, a column this database does
--     not have). Here a session ends after 10 questions, as 0029 did. Time is
--     still recorded server-side: served_at, step_events.happened_at, and
--     tutoring_attempts.time_taken_ms. DECISION PENDING with the researcher.
--   * No external ML call. The tutor's wording profile stays "average", the
--     game's own default. DECISION PENDING with the researcher.
--   * Questions whose steps JSON is missing or short are not served. The game
--     rebuilt steps in the browser from the question text for older rows; that
--     guesses an answer key, so it is not ported. The Admin Math Task editor
--     is where steps are authored.
--   * "^" is not accepted in working (Grade 7 arithmetic; it also keeps the
--     evaluator below trivially safe).
--   * Classification. The attached game has no smooth/struggling label. Its
--     only per-question rule is "accurate": finished with no wrong answer
--     (hints do not count against it, time is not part of it). That is the
--     rule used for both is_correct and classification ('smooth' when
--     accurate, else 'struggling'). No time or hint threshold is invented.
--
-- OLD CALLS ARE NOT CLOSED HERE. serve_next_question, check_question_answer,
-- consume_question_hint, reveal_question_solution and record_question_result
-- (0029) stay executable by signed-in users. They enforce the two-try rule,
-- so once every caller has moved they should be revoked: see
-- supabase/PROPOSED_close_old_question_rpcs.sql (not a migration; run it
-- only after the regression suites pass).
--
-- SAFE TO RE-RUN: tables/columns only if missing, functions replaced.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- PREFLIGHT
-- ---------------------------------------------------------------------------
do $$
declare
  v_problems text := '';
  t          text;
begin
  foreach t in array array['served_questions', 'student_topic_progress', 'topic_changes',
                           'tutoring_attempts', 'problem_serves', 'app_config', 'profiles'] loop
    if to_regclass('public.' || t) is null then
      v_problems := v_problems || 'public.' || t || ' is missing; ';
    end if;
  end loop;
  if to_regprocedure('public.pia_caller_role()') is null
     or to_regprocedure('public.jwt_is_current()') is null then
    v_problems := v_problems || 'pia_caller_role()/jwt_is_current() are missing; ';
  end if;
  if to_regprocedure('public.pia_parse_hint(text)') is null
     or to_regprocedure('public.pia_student_topic(text)') is null
     or to_regprocedure('public.pia_result_payload(uuid,text,text)') is null then
    v_problems := v_problems || '0029 helpers are missing (run 0029 first); ';
  end if;
  if to_regprocedure('public.pia_can_enter_stage(boolean, text, text, text)') is null
     or not exists (select 1 from pg_trigger where tgname = 'trg_pia_control_stage_guard') then
    v_problems := v_problems || '0038 (Control OCEAN-only) is missing -- apply it first; ';
  end if;
  if to_regprocedure('public.start_game_session()') is null then
    v_problems := v_problems || 'start_game_session() is missing; ';
  end if;
  if v_problems <> '' then
    raise exception 'PIA 0039 ABORT (nothing changed): %', v_problems using errcode = 'P0001';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 1. Tables. No grants: only the functions below touch them. The three event
--    tables are readable by admins for the analysis.
-- ---------------------------------------------------------------------------
alter table public.student_topic_progress
  add column if not exists failed_streak int not null default 0;

create table if not exists public.step_states (
  session_id    uuid        not null,
  student_email text        not null,
  problem_id    text        not null,
  step_index    int         not null default 0,           -- 0-based step being worked on
  stage         text        not null default 'work' check (stage in ('work', 'confirm')),
  work_text     text,                                      -- correct working awaiting its final value
  wrong_streak  int         not null default 0,            -- wrong answers on this step/stage
  hint_tier     int         not null default 0,            -- 0 = none yet; repeats at the last tier
  errors        int         not null default 0,            -- every wrong answer, whole question
  hints         int         not null default 0,            -- every hint pressed, whole question
  hint_unlocked boolean     not null default false,
  done_steps    jsonb       not null default '[]'::jsonb,  -- [{"text":..,"confirmed":..}]
  completed     boolean     not null default false,
  updated_at    timestamptz not null default now(),
  primary key (session_id, student_email, problem_id)
);

create table if not exists public.step_events (
  id            bigint generated always as identity primary key,
  session_id    uuid        not null,
  student_email text        not null,
  problem_id    text        not null,
  step_index    int         not null,
  stage         text        not null,
  submitted     text        not null,
  outcome       text        not null,   -- wrong | needs_final | format_error | step_done | question_done
  happened_at   timestamptz not null default now()
);
create index if not exists step_events_lookup_idx on public.step_events (session_id, student_email, problem_id);

create table if not exists public.step_hints (
  id            bigint generated always as identity primary key,
  session_id    uuid        not null,
  student_email text        not null,
  problem_id    text        not null,
  step_index    int         not null,
  tier          int         not null,
  tiers_total   int         not null,
  taken_at      timestamptz not null default now()
);
create index if not exists step_hints_lookup_idx on public.step_hints (session_id, student_email, problem_id);

create table if not exists public.topic_offers (
  session_id    uuid        not null,
  student_email text        not null,
  problem_id    text        not null,
  offer         text        not null check (offer in ('up', 'down')),
  from_topic    int         not null,
  target_topic  int         not null,
  status        text        not null default 'pending' check (status in ('pending', 'accepted', 'refused')),
  created_at    timestamptz not null default now(),
  resolved_at   timestamptz,
  primary key (session_id, student_email, problem_id)
);

alter table public.step_states  enable row level security;
alter table public.step_events  enable row level security;
alter table public.step_hints   enable row level security;
alter table public.topic_offers enable row level security;

revoke all on public.step_states  from public, anon, authenticated;
revoke all on public.step_events  from public, anon, authenticated;
revoke all on public.step_hints   from public, anon, authenticated;
revoke all on public.topic_offers from public, anon, authenticated;

drop policy if exists step_events_admin_read on public.step_events;
create policy step_events_admin_read on public.step_events
  for select to authenticated
  using (public.pia_caller_role() = 'admin' and public.jwt_is_current());
drop policy if exists step_hints_admin_read on public.step_hints;
create policy step_hints_admin_read on public.step_hints
  for select to authenticated
  using (public.pia_caller_role() = 'admin' and public.jwt_is_current());
drop policy if exists topic_offers_admin_read on public.topic_offers;
create policy topic_offers_admin_read on public.topic_offers
  for select to authenticated
  using (public.pia_caller_role() = 'admin' and public.jwt_is_current());
grant select on public.step_events  to authenticated;
grant select on public.step_hints   to authenticated;
grant select on public.topic_offers to authenticated;


-- ---------------------------------------------------------------------------
-- 2. Helpers (not callable from the browser)
-- ---------------------------------------------------------------------------

-- Steps per topic: Topic 1 has 2, Topics 2 and 3 have 3.
create or replace function public.pia_step_required(p_topic int)
returns int language sql immutable as $$
  select case when p_topic = 1 then 2 else 3 end;
$$;

-- The name shown on a step card. p_idx is 0-based.
create or replace function public.pia_step_label(p_topic int, p_idx int)
returns text language sql immutable as $$
  select case when p_topic = 1 then (array['Conversion', 'Multiplication'])[p_idx + 1]
              else (array['Subtraction', 'Division', 'Conversion'])[p_idx + 1] end;
$$;

-- What the confirm box must hold: a decimal (Topic 1 conversion), a
-- percentage (Topic 2-3 conversion) or a plain number.
create or replace function public.pia_step_confirm_kind(p_topic int, p_idx int)
returns text language sql immutable as $$
  select case when public.pia_step_label(p_topic, p_idx) = 'Conversion'
              then (case when p_topic = 1 then 'decimal' else 'percentage' end)
              else 'number' end;
$$;

-- A question can be served only if its first N steps all carry an answer.
create or replace function public.pia_steps_valid(p_steps jsonb, p_topic int)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  n int := public.pia_step_required(p_topic);
  i int;
begin
  if p_steps is null or jsonb_typeof(p_steps) <> 'array' or jsonb_array_length(p_steps) < n then
    return false;
  end if;
  for i in 0 .. n - 1 loop
    if nullif(trim(coalesce(p_steps -> i ->> 'answer', p_steps -> i ->> 'stepAnswer', '')), '') is null then
      return false;
    end if;
  end loop;
  return true;
end;
$$;

-- Evaluates plain arithmetic the way the game did (math.js), or null if the
-- text is not arithmetic. DYNAMIC SQL, so the whitelist below is the safety:
-- only digits, + - * / ( ) . and whitespace ever reach EXECUTE -- no letters,
-- quotes, semicolons or "$". "--" and "/*" (SQL comment starters) are
-- refused, and 60 characters is the cap (the callers truncate to 60).
create or replace function public.pia_eval_expr(p_text text)
returns numeric
language plpgsql
volatile
set search_path = pg_catalog, public
as $$
declare
  e text := coalesce(p_text, '');
  r numeric;
begin
  e := replace(e, ',', '');
  e := regexp_replace(e, 'PHP|₱', '', 'gi');
  e := translate(e, '×·÷−', '**/-');
  e := replace(e, '%', '');
  e := regexp_replace(e, '(\d|\))\s*[xX]\s*(\d|\()', '\1*\2', 'g');
  e := btrim(e);

  if e = '' or length(e) > 60 then return null; end if;
  if e !~ '^[0-9+*/(). [:space:]-]+$' then return null; end if;
  if position('--' in e) > 0 or position('/*' in e) > 0 or position('*/' in e) > 0 then
    return null;
  end if;

  -- Every number becomes numeric first, or 80/100 would be integer division.
  e := regexp_replace(e, '(\d+\.?\d*|\.\d+)', '(\1)::numeric', 'g');

  begin
    execute 'select (' || e || ')::numeric' into r;
  exception when others then
    return null;       -- syntax error, divide by zero, overflow
  end;
  return r;
end;
$$;

-- Same value within 0.001, else a case-insensitive text match -- the game's
-- isCorrectMathValue().
create or replace function public.pia_step_matches(p_submitted text, p_key text)
returns boolean
language plpgsql
volatile
set search_path = public
as $$
declare
  u numeric := public.pia_eval_expr(p_submitted);
  k numeric := public.pia_eval_expr(p_key);
begin
  if u is not null and k is not null then
    return abs(u - k) <= 0.001;
  end if;
  return lower(trim(coalesce(p_submitted, ''))) = lower(trim(coalesce(p_key, '')));
end;
$$;

-- Did the student type working (an operation) instead of one value? The
-- game's containsMathOperation().
create or replace function public.pia_has_working(p_text text)
returns boolean
language sql
immutable
as $$
  with t as (
    select regexp_replace(translate(btrim(coalesce(p_text, '')), '×·÷−', '**/-'), '^[+-]\s*', '') as w
  )
  select w ~ '[*/^()]'
      or w ~ '\d\s*[xX]\s*(\d|\.)'
      or w ~ '(\d|\))\s*[+-]\s*(\d|\()'
  from t;
$$;

-- Is this one value in the shape the confirm box wants? A percentage may
-- carry a % sign; a decimal or plain number may not.
create or replace function public.pia_is_final_format(p_kind text, p_text text)
returns boolean
language sql
immutable
as $$
  select case when p_kind = 'percentage'
              then btrim(coalesce(p_text, '')) ~ '^[+-]?(\d+(\.\d+)?|\.\d+)\s*%?$'
              else btrim(coalesce(p_text, '')) ~ '^[+-]?(\d+(\.\d+)?|\.\d+)$' end;
$$;

-- "0.80" -> "0.8", and "20" -> "20%" for a percentage.
create or replace function public.pia_format_final(p_kind text, p_value numeric)
returns text
language sql
immutable
as $$
  select trim_scale(round(p_value, 10))::text || case when p_kind = 'percentage' then '%' else '' end;
$$;

-- The hints of one step, easiest first.
create or replace function public.pia_step_hints(p_step jsonb, p_default text)
returns text[]
language plpgsql
immutable
set search_path = public
as $$
declare
  r text[] := '{}';
  t int;
  v text;
begin
  for t in 1 .. 3 loop
    v := nullif(trim(coalesce(p_step ->> ('hint' || t), '')), '');
    if v is not null then r := r || v; end if;
  end loop;

  if cardinality(r) = 0 and jsonb_typeof(p_step -> 'hints') = 'array' then
    select coalesce(array_agg(trim(e.v) order by e.ord) filter (where nullif(trim(e.v), '') is not null), '{}')
      into r
      from jsonb_array_elements_text(p_step -> 'hints') with ordinality as e(v, ord);
  end if;

  if cardinality(r) = 0 then
    r := array[coalesce(nullif(trim(coalesce(p_default, '')), ''), 'Check your calculations carefully.')];
  end if;
  return r;
end;
$$;

-- The configured rules for one topic (defaults match 0028).
create or replace function public.pia_topic_rules(p_topic int, out mastery int, out min_q int, out max_err int)
language plpgsql
stable
set search_path = public
as $$
begin
  select coalesce(case p_topic when 1 then c.easy_mastery when 2 then c.medium_mastery else c.hard_mastery end, 80),
         coalesce(case p_topic when 1 then c.easy_min_questions when 2 then c.medium_min_questions else c.hard_min_questions end, 3),
         coalesce(case p_topic when 1 then c.easy_max_errors when 2 then c.medium_max_errors else c.hard_max_errors end, 3)
    into mastery, min_q, max_err
    from public.app_config c where c.id = 1;
  if not found then
    mastery := 80; min_q := 3; max_err := 3;
  end if;
end;
$$;

-- What the browser may know about a question's state: never a key.
create or replace function public.pia_step_state_json(sq public.served_questions, st public.step_states)
returns jsonb
language sql
stable
set search_path = public
as $$
  select jsonb_build_object(
    'done',           false,
    'problem_id',     sq.problem_id,
    'problem_number', sq.problem_number,
    'question',       sq.question,
    'topic',          sq.student_topic,
    'question_topic', sq.topic,
    'steps_total',    public.pia_step_required(sq.topic),
    'step_labels',    (select jsonb_agg(public.pia_step_label(sq.topic, g - 1) order by g)
                         from generate_series(1, public.pia_step_required(sq.topic)) g),
    'current_step',   st.step_index,
    'stage',          st.stage,
    'confirm_kind',   case when st.stage = 'confirm'
                           then public.pia_step_confirm_kind(sq.topic, st.step_index) end,
    'work_text',      st.work_text,
    'done_steps',     st.done_steps,
    'wrong_streak',   st.wrong_streak,
    'hint_unlocked',  st.hint_unlocked,
    'hint_tier',      st.hint_tier,
    'errors',         st.errors,
    'hints_used',     st.hints,
    'locked',         st.completed);
$$;

-- Signed in, current, a student, and allowed into the Tutoring Dashboard for
-- their research group. Returns the email.
create or replace function public.pia_game_email()
returns text
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  v_email text := auth.jwt() ->> 'email';
  p       public.profiles%rowtype;
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;
  if public.pia_caller_role() is distinct from 'student' then
    raise exception 'PIA: only students take lessons.' using errcode = '42501';
  end if;

  select * into p from public.profiles where email = v_email;
  if not found
     or not public.pia_can_enter_stage(p.is_ocean_done, p.group_type, p.selected_character, 'Tutoring Dashboard')
     or lower(trim(coalesce(p.group_type, ''))) not in ('assigned', 'neutral', 'non-assigned', 'non_assigned')
     or p.selected_character is null then
    raise exception 'PIA: the tutoring game is not available to this account.' using errcode = '42501';
  end if;
  return v_email;
end;
$$;

revoke all on function public.pia_step_required(int)                              from public, anon, authenticated;
revoke all on function public.pia_step_label(int, int)                            from public, anon, authenticated;
revoke all on function public.pia_step_confirm_kind(int, int)                     from public, anon, authenticated;
revoke all on function public.pia_steps_valid(jsonb, int)                         from public, anon, authenticated;
revoke all on function public.pia_eval_expr(text)                                 from public, anon, authenticated;
revoke all on function public.pia_step_matches(text, text)                        from public, anon, authenticated;
revoke all on function public.pia_has_working(text)                               from public, anon, authenticated;
revoke all on function public.pia_is_final_format(text, text)                     from public, anon, authenticated;
revoke all on function public.pia_format_final(text, numeric)                     from public, anon, authenticated;
revoke all on function public.pia_step_hints(jsonb, text)                         from public, anon, authenticated;
revoke all on function public.pia_topic_rules(int)                                from public, anon, authenticated;
revoke all on function public.pia_step_state_json(public.served_questions, public.step_states) from public, anon, authenticated;
revoke all on function public.pia_game_email()                                    from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. The student's calls
-- ---------------------------------------------------------------------------

-- The next thing for this session: an offer still waiting for an answer, an
-- open question exactly as it was left, or a new question chosen by the
-- server (the student's topic first, then least seen, then at random).
create or replace function public.serve_next_step_question(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email    text;
  c_target   constant int := 10;       -- SESSION_TARGET in student-dashboard.js
  v_offer    public.topic_offers%rowtype;
  v_sq       public.served_questions%rowtype;
  v_st       public.step_states%rowtype;
  v_answered int;
  v_topic    int;
  v_q        record;
  v_parsed   jsonb;
begin
  v_email := public.pia_game_email();
  if p_session_id is null then
    raise exception 'PIA: a session is required.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('pia-lesson:' || v_email));

  select * into v_offer from public.topic_offers
   where session_id = p_session_id and student_email = v_email and status = 'pending'
   order by created_at desc limit 1;
  if found then
    return jsonb_build_object('done', false, 'pending_offer', jsonb_build_object(
      'problem_id', v_offer.problem_id, 'type', v_offer.offer,
      'from_topic', v_offer.from_topic, 'target_topic', v_offer.target_topic));
  end if;

  select sq.* into v_sq
    from public.served_questions sq
   where sq.session_id = p_session_id and sq.student_email = v_email
     and exists (select 1 from public.step_states s
                  where s.session_id = sq.session_id and s.student_email = sq.student_email
                    and s.problem_id = sq.problem_id)
     and not exists (select 1 from public.tutoring_attempts t
                      where t.session_id = sq.session_id and t.student_email = sq.student_email
                        and t.problem_id = sq.problem_id)
   order by sq.problem_number desc
   limit 1;

  if found then
    select * into v_st from public.step_states
     where session_id = v_sq.session_id and student_email = v_email and problem_id = v_sq.problem_id;
    return public.pia_step_state_json(v_sq, v_st);
  end if;

  select count(*) into v_answered
    from public.tutoring_attempts t
   where t.session_id = p_session_id and t.student_email = v_email and t.problem_id like 'qb-%';

  if v_answered >= c_target then
    return jsonb_build_object('done', true, 'reason', 'target', 'problems_answered', v_answered);
  end if;

  v_topic := public.pia_student_topic(v_email);

  select q.id, q.question, q.final_answer, q.hint,
         case upper(q.difficulty) when 'EASY' then 1 when 'MEDIUM' then 2 else 3 end as topic
    into v_q
    from public.question_bank q
   where upper(q.difficulty) in ('EASY', 'MEDIUM', 'HARD')
     and trim(coalesce(q.question, '')) <> ''
     and public.pia_steps_valid(
           public.pia_parse_hint(q.hint) -> 'steps',
           case upper(q.difficulty) when 'EASY' then 1 when 'MEDIUM' then 2 else 3 end)
     and not exists (select 1 from public.served_questions s
                      where s.session_id = p_session_id and s.student_email = v_email
                        and s.question_id = q.id)
   order by abs((case upper(q.difficulty) when 'EASY' then 1 when 'MEDIUM' then 2 else 3 end) - v_topic),
            (select count(*) from public.served_questions s2
              where s2.student_email = v_email and s2.question_id = q.id),
            random()
   limit 1;

  if not found then
    return jsonb_build_object('done', true, 'reason', 'bank_empty', 'problems_answered', v_answered);
  end if;

  v_parsed := public.pia_parse_hint(v_q.hint);

  insert into public.served_questions (
    session_id, student_email, problem_id, problem_number, question_id,
    topic, student_topic, question, final_answer, steps, default_hint)
  values (
    p_session_id, v_email, 'qb-' || v_q.id, v_answered + 1, v_q.id,
    v_q.topic, v_topic, v_q.question, coalesce(v_q.final_answer, ''),
    v_parsed -> 'steps', nullif(v_parsed ->> 'defaultHint', ''))
  returning * into v_sq;

  insert into public.step_states (session_id, student_email, problem_id)
  values (p_session_id, v_email, v_sq.problem_id)
  returning * into v_st;

  -- The serve stamp that timing (and the teacher monitor) already use.
  insert into public.problem_serves (session_id, student_email, problem_id, problem_number)
  values (p_session_id, v_email, v_sq.problem_id, v_sq.problem_number)
  on conflict (session_id, problem_id) do nothing;

  return public.pia_step_state_json(v_sq, v_st);
end;
$$;


-- One submission for the step the student is on. The step is the server's
-- choice, not the browser's.
create or replace function public.check_step_answer(p_session_id uuid, p_problem_id text, p_submitted text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email    text;
  v_sub      text := left(trim(coalesce(p_submitted, '')), 60);
  v_sq       public.served_questions%rowtype;
  v_st       public.step_states%rowtype;
  v_required int;
  v_step     jsonb;
  v_key      numeric;
  v_kind     text;
  v_idx      int;
  v_stage    text;
  v_num      numeric;
  v_outcome  text;
  v_text     text;
  v_confirm  text;
begin
  v_email := public.pia_game_email();
  if v_sub = '' then
    raise exception 'PIA: an answer is required.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('pia-lesson:' || v_email));

  select * into v_sq from public.served_questions
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;
  select * into v_st from public.step_states
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id
   for update;
  if v_sq.problem_id is null or v_st.problem_id is null then
    raise exception 'PIA: this question was not served to you.' using errcode = '42501';
  end if;

  if v_st.completed
     or exists (select 1 from public.tutoring_attempts t
                 where t.session_id = p_session_id and t.student_email = v_email and t.problem_id = p_problem_id) then
    return jsonb_build_object('outcome', 'locked', 'state', public.pia_step_state_json(v_sq, v_st));
  end if;

  v_required := public.pia_step_required(v_sq.topic);
  v_idx      := v_st.step_index;
  v_stage    := v_st.stage;
  v_step     := v_sq.steps -> v_idx;
  v_kind     := public.pia_step_confirm_kind(v_sq.topic, v_idx);
  v_key      := public.pia_eval_expr(coalesce(v_step ->> 'answer', v_step ->> 'stepAnswer', ''));

  if v_stage = 'work' then
    if not public.pia_step_matches(v_sub, coalesce(v_step ->> 'answer', v_step ->> 'stepAnswer', '')) then
      v_outcome := 'wrong';
    elsif not public.pia_has_working(v_sub) and public.pia_is_final_format(v_kind, v_sub) then
      v_outcome := 'step_done';
      v_num     := public.pia_eval_expr(v_sub);
      v_text    := public.pia_format_final(v_kind, v_num);
    else
      -- Right value, but working or not in the final shape: ask for the value.
      v_outcome := 'needs_final';
    end if;
  else
    if public.pia_is_final_format(v_kind, v_sub) then
      v_num := public.pia_eval_expr(v_sub);
    end if;
    if v_num is not null and v_key is not null and abs(v_num - v_key) <= 0.001 then
      v_outcome := 'step_done';
      v_text    := coalesce(v_st.work_text, public.pia_format_final(v_kind, v_num));
      v_confirm := public.pia_format_final(v_kind, v_num);
    else
      v_outcome := 'format_error';
    end if;
  end if;

  insert into public.step_events (session_id, student_email, problem_id, step_index, stage, submitted, outcome)
  values (p_session_id, v_email, p_problem_id, v_idx, v_stage, v_sub,
          case when v_outcome = 'step_done' and v_idx + 1 >= v_required then 'question_done' else v_outcome end);

  if v_outcome in ('wrong', 'format_error') then
    update public.step_states
       set errors = errors + 1,
           wrong_streak = wrong_streak + 1,
           hint_unlocked = hint_unlocked or (wrong_streak + 1 >= 2),
           updated_at = now()
     where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id
     returning * into v_st;

  elsif v_outcome = 'needs_final' then
    update public.step_states
       set stage = 'confirm', work_text = v_sub, wrong_streak = 0, hint_tier = 0, updated_at = now()
     where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id
     returning * into v_st;

  else  -- step_done
    update public.step_states
       set done_steps = done_steps || jsonb_build_array(
             jsonb_build_object('text', v_text, 'confirmed', v_confirm)),
           step_index = step_index + 1,
           stage = 'work', work_text = null, wrong_streak = 0, hint_tier = 0,
           completed = (step_index + 1 >= v_required),
           updated_at = now()
     where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id
     returning * into v_st;
    if v_st.completed then v_outcome := 'question_done'; end if;
  end if;

  return jsonb_build_object(
    'outcome',   v_outcome,
    'step_text', v_text,
    'confirmed', v_confirm,
    'state',     public.pia_step_state_json(v_sq, v_st));
end;
$$;


-- The next hint for the current step. Only after two wrong answers.
create or replace function public.consume_step_hint(p_session_id uuid, p_problem_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text;
  v_sq    public.served_questions%rowtype;
  v_st    public.step_states%rowtype;
  v_list  text[];
  v_tier  int;
begin
  v_email := public.pia_game_email();
  perform pg_advisory_xact_lock(hashtext('pia-lesson:' || v_email));

  select * into v_sq from public.served_questions
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;
  select * into v_st from public.step_states
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id
   for update;
  if v_sq.problem_id is null or v_st.problem_id is null then
    raise exception 'PIA: this question was not served to you.' using errcode = '42501';
  end if;

  if v_st.completed or not v_st.hint_unlocked then
    return jsonb_build_object('hint', null, 'state', public.pia_step_state_json(v_sq, v_st));
  end if;

  v_list := public.pia_step_hints(v_sq.steps -> v_st.step_index, v_sq.default_hint);
  v_tier := least(v_st.hint_tier + 1, cardinality(v_list));

  insert into public.step_hints (session_id, student_email, problem_id, step_index, tier, tiers_total)
  values (p_session_id, v_email, p_problem_id, v_st.step_index, v_tier, cardinality(v_list));

  update public.step_states
     set hint_tier = v_tier, hints = hints + 1, updated_at = now()
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id
   returning * into v_st;

  return jsonb_build_object(
    'hint', jsonb_build_object(
      'text', v_list[v_tier], 'tier', v_tier, 'tiers_total', cardinality(v_list),
      'step', v_st.step_index + 1),
    'state', public.pia_step_state_json(v_sq, v_st));
end;
$$;


-- Records a finished question and decides whether to OFFER a topic change.
-- Safe to call twice: the second call returns the first result.
create or replace function public.finish_step_question(p_session_id uuid, p_problem_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email  text;
  v_sq     public.served_questions%rowtype;
  v_st     public.step_states%rowtype;
  v_prog   public.student_topic_progress%rowtype;
  v_served timestamptz;
  v_last   timestamptz;
  v_ms     bigint;
  v_att    int;
  v_class  text;
  v_acc    boolean;
  v_topic  int;
  v_done   int;
  v_good   int;
  v_streak int;
  v_rule   record;
  v_offer  text;
  v_target int;
  v_pend   public.topic_offers%rowtype;
begin
  v_email := public.pia_game_email();
  perform pg_advisory_xact_lock(hashtext('pia-lesson:' || v_email));

  select * into v_sq from public.served_questions
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;
  select * into v_st from public.step_states
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;
  if v_sq.problem_id is null or v_st.problem_id is null then
    raise exception 'PIA: this question was not served to you.' using errcode = '42501';
  end if;

  if exists (select 1 from public.tutoring_attempts
              where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id) then
    select * into v_pend from public.topic_offers
     where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id and status = 'pending';
    return public.pia_result_payload(p_session_id, v_email, p_problem_id)
           || jsonb_build_object('errors', v_st.errors,
                'offer', case when v_pend.problem_id is not null then jsonb_build_object(
                  'type', v_pend.offer, 'from_topic', v_pend.from_topic, 'target_topic', v_pend.target_topic) end);
  end if;

  if not v_st.completed then
    raise exception 'PIA: finish every step first.' using errcode = '42501';
  end if;

  select served_at into v_served from public.problem_serves
   where session_id = p_session_id and problem_id = p_problem_id;
  if v_served is null then
    raise exception 'PIA: this question was not served.' using errcode = '42501';
  end if;
  select max(happened_at), count(*) into v_last, v_att from public.step_events
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;
  v_ms := greatest(0, least(3600000,
            (extract(epoch from (coalesce(v_last, now()) - v_served)) * 1000)::bigint));

  v_acc   := v_st.errors = 0;
  -- The attached game's one rule: accurate = no wrong answer. Hints and
  -- time are recorded (hints_used, time_taken_ms) but do not decide it.
  v_class := case when v_acc then 'smooth' else 'struggling' end;

  -- The topic window.
  insert into public.student_topic_progress (student_email) values (v_email)
  on conflict (student_email) do nothing;
  select * into v_prog from public.student_topic_progress where student_email = v_email for update;

  v_topic := v_prog.topic;
  v_done  := v_prog.stint_answered + 1;
  v_good  := v_prog.stint_correct + case when v_acc then 1 else 0 end;
  v_streak := case when v_acc then 0 else v_prog.failed_streak + 1 end;

  select * into v_rule from public.pia_topic_rules(v_topic);

  v_offer := null;
  if v_topic > 1 and v_streak >= v_rule.max_err then
    v_offer := 'down'; v_target := v_topic - 1;
  elsif v_topic < 3 and v_done >= v_rule.min_q and v_good * 100 >= v_rule.mastery * v_done then
    v_offer := 'up';   v_target := v_topic + 1;
  end if;

  update public.student_topic_progress
     set stint_answered = v_done, stint_correct = v_good, failed_streak = v_streak, updated_at = now()
   where student_email = v_email;

  if v_offer is not null then
    insert into public.topic_offers (session_id, student_email, problem_id, offer, from_topic, target_topic)
    values (p_session_id, v_email, p_problem_id, v_offer, v_topic, v_target)
    on conflict do nothing;
  end if;

  -- level_before / level_after hold the TOPIC (1-3), as in 0029. A topic
  -- changes only when the student accepts an offer, so they match here.
  insert into public.tutoring_attempts (
    session_id, student_email, problem_id, problem_number,
    level_before, level_after, attempts_used, hints_used,
    time_taken_ms, is_correct, classification)
  values (
    p_session_id, v_email, p_problem_id, v_sq.problem_number,
    v_topic, v_topic, least(10, v_att), least(10, v_st.hints),
    v_ms, v_acc, v_class)
  on conflict (session_id, problem_number) do nothing;

  return public.pia_result_payload(p_session_id, v_email, p_problem_id)
         || jsonb_build_object('errors', v_st.errors,
              'offer', case when v_offer is not null then jsonb_build_object(
                'type', v_offer, 'from_topic', v_topic, 'target_topic', v_target) end);
end;
$$;


-- The student's answer to a topic offer.
create or replace function public.respond_topic_offer(p_session_id uuid, p_problem_id text, p_accept boolean)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text;
  v_off   public.topic_offers%rowtype;
  v_prog  public.student_topic_progress%rowtype;
  v_rule  record;
  v_to    int;
begin
  v_email := public.pia_game_email();
  perform pg_advisory_xact_lock(hashtext('pia-lesson:' || v_email));

  select * into v_off from public.topic_offers
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id
   for update;
  if not found then
    raise exception 'PIA: there is no offer to answer.' using errcode = '42501';
  end if;
  if v_off.status <> 'pending' then
    return jsonb_build_object('topic', public.pia_student_topic(v_email), 'status', v_off.status);
  end if;

  select * into v_prog from public.student_topic_progress where student_email = v_email for update;
  select * into v_rule from public.pia_topic_rules(v_off.from_topic);
  v_to := case when p_accept then v_off.target_topic else v_off.from_topic end;

  insert into public.topic_changes (
    student_email, session_id, problem_number, from_topic, to_topic, reason,
    stint_answered, stint_correct, stint_wrong, mastery, min_solved, max_errors)
  values (
    v_email, p_session_id,
    (select problem_number from public.served_questions
      where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id),
    v_off.from_topic, v_to,
    (case when p_accept then 'accepted_' else 'refused_' end) || v_off.offer,
    v_prog.stint_answered, v_prog.stint_correct, v_prog.failed_streak,
    v_rule.mastery, v_rule.min_q, v_rule.max_err);

  if p_accept then
    -- A new topic starts a fresh window.
    update public.student_topic_progress
       set topic = v_to, stint_answered = 0, stint_correct = 0, failed_streak = 0, updated_at = now()
     where student_email = v_email;
  elsif v_off.offer = 'up' then
    update public.student_topic_progress
       set stint_answered = 0, stint_correct = 0, failed_streak = 0, updated_at = now()
     where student_email = v_email;
  else
    update public.student_topic_progress
       set failed_streak = 0, updated_at = now()
     where student_email = v_email;
  end if;

  update public.topic_offers
     set status = case when p_accept then 'accepted' else 'refused' end, resolved_at = now()
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;

  return jsonb_build_object('topic', v_to, 'status', case when p_accept then 'accepted' else 'refused' end);
end;
$$;


-- ---------------------------------------------------------------------------
-- 4. Resume: the same as 0029, behind the same access check.
-- ---------------------------------------------------------------------------
create or replace function public.resume_or_start_game_session()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email    text;
  v_session  uuid;
  v_answered int;
  v_correct  int;
  v_pending  text;
  v_streak   int := 0;
  r          record;
begin
  v_email := public.pia_game_email();

  select ps.session_id into v_session
    from public.problem_serves ps
   where ps.student_email = v_email and ps.problem_id like 'qb-%'
   order by ps.served_at desc
   limit 1;

  if v_session is not null then
    select count(*), coalesce(count(*) filter (where is_correct), 0)
      into v_answered, v_correct
      from public.tutoring_attempts
     where session_id = v_session and student_email = v_email and problem_id like 'qb-%';

    if v_answered < 10 then
      select sq.problem_id into v_pending
        from public.served_questions sq
       where sq.session_id = v_session and sq.student_email = v_email
         and not exists (select 1 from public.tutoring_attempts t
                          where t.session_id = sq.session_id and t.student_email = sq.student_email
                            and t.problem_id = sq.problem_id)
       order by sq.problem_number desc
       limit 1;

      -- Time away is not time on task: the open question's clock restarts.
      if v_pending is not null then
        update public.problem_serves set served_at = now()
         where session_id = v_session and problem_id = v_pending;
      end if;

      for r in select a.is_correct from public.tutoring_attempts a
                where a.session_id = v_session and a.student_email = v_email and a.problem_id like 'qb-%'
                order by a.problem_number desc loop
        exit when not r.is_correct;
        v_streak := v_streak + 1;
      end loop;

      return jsonb_build_object(
        'session_id',          v_session,
        'resumed',             true,
        'problems_answered',   v_answered,
        'correct_count',       v_correct,
        'topic',               public.pia_student_topic(v_email),
        'consecutive_correct', v_streak,
        'pending_problem_id',  v_pending);
    end if;
  end if;

  return jsonb_build_object(
    'session_id',          public.start_game_session(),
    'resumed',             false,
    'problems_answered',   0,
    'correct_count',       0,
    'topic',               public.pia_student_topic(v_email),
    'consecutive_correct', 0,
    'pending_problem_id',  null);
end;
$$;


-- ---------------------------------------------------------------------------
-- 5. Grants.
-- ---------------------------------------------------------------------------
revoke all on function public.serve_next_step_question(uuid)                   from public, anon;
revoke all on function public.check_step_answer(uuid, text, text)              from public, anon;
revoke all on function public.consume_step_hint(uuid, text)                    from public, anon;
revoke all on function public.finish_step_question(uuid, text)                 from public, anon;
revoke all on function public.respond_topic_offer(uuid, text, boolean)         from public, anon;
revoke all on function public.resume_or_start_game_session()                   from public, anon;
grant execute on function public.serve_next_step_question(uuid)                to authenticated;
grant execute on function public.check_step_answer(uuid, text, text)           to authenticated;
grant execute on function public.consume_step_hint(uuid, text)                 to authenticated;
grant execute on function public.finish_step_question(uuid, text)              to authenticated;
grant execute on function public.respond_topic_offer(uuid, text, boolean)      to authenticated;
grant execute on function public.resume_or_start_game_session()               to authenticated;



-- ---------------------------------------------------------------------------
-- 6. A student cannot change their tutor from the browser.
--    0001 lets a student write selected_character on their own row. That is
--    right for a free-choice student's one pick, and wrong for an assigned
--    student, whose tutor is the admin's and part of the experiment. From the
--    browser a non-admin may now set it only once, while it is empty, in the
--    free-choice group, to one of the six known tutors. Admin edits and the
--    admin "re-select" reset are untouched.
-- ---------------------------------------------------------------------------
create or replace function public.pia_guard_tutor_choice()
returns trigger
language plpgsql
security invoker              -- invoker, so current_user is the real caller (as in 0001)
set search_path = public
as $$
begin
  if current_user <> 'authenticated' then return new; end if;
  if new.selected_character is not distinct from old.selected_character then return new; end if;
  if public.pia_caller_role() = 'admin' then return new; end if;

  if old.selected_character is null
     and lower(trim(coalesce(old.group_type, ''))) in ('non-assigned', 'non_assigned')
     and new.selected_character in ('pia-open', 'pia-conscientious', 'pia-extravert',
                                    'pia-agreeable', 'pia-calm', 'pia-neutral') then
    return new;
  end if;

  raise exception 'PIA: your tutor is set for you and cannot be changed here.' using errcode = '42501';
end;
$$;

drop trigger if exists profiles_guard_tutor_choice on public.profiles;
create trigger profiles_guard_tutor_choice
  before update of selected_character on public.profiles
  for each row execute function public.pia_guard_tutor_choice();


-- ---------------------------------------------------------------------------
-- 7. SELF-TEST of the pure helpers. If any line fails, the whole migration
--    rolls back and says which. (The database calls above are NOT exercised
--    here: see the notes below.)
-- ---------------------------------------------------------------------------
do $$
begin
  assert public.pia_eval_expr('0.3 x 30') = 9,           'eval: 0.3 x 30';
  assert public.pia_eval_expr('80/100') = 0.8,           'eval: 80/100';
  assert public.pia_eval_expr('50 - 20') = 30,           'eval: 50 - 20';
  assert public.pia_eval_expr('(10+5)*2') = 30,          'eval: parentheses';
  assert public.pia_eval_expr('20%') = 20,               'eval: percent sign';
  assert public.pia_eval_expr('1,200') = 1200,           'eval: comma';
  assert public.pia_eval_expr('5--3') is null,           'eval: comment starter refused';
  assert public.pia_eval_expr('5/0') is null,            'eval: divide by zero';
  assert public.pia_eval_expr('abc') is null,            'eval: letters refused';
  assert public.pia_eval_expr('1; drop table x') is null, 'eval: semicolon refused';

  assert public.pia_step_matches('0.8', '0.80'),         'match: 0.8';
  assert public.pia_step_matches('20', '20%'),           'match: 20 vs 20%';
  assert public.pia_step_matches('30*0.3', '9'),         'match: working';
  assert not public.pia_step_matches('9.5', '9'),        'match: wrong value';

  assert public.pia_has_working('30 x 0.3'),             'working: x';
  assert public.pia_has_working('80/100'),               'working: divide';
  assert public.pia_has_working('50 - 20'),              'working: subtract';
  assert not public.pia_has_working('-5'),               'working: leading sign';
  assert not public.pia_has_working('0.8'),              'working: plain';

  assert public.pia_is_final_format('percentage', '20%'), 'format: 20%';
  assert public.pia_is_final_format('percentage', '20'),  'format: 20';
  assert not public.pia_is_final_format('decimal', '20%'), 'format: decimal with %';
  assert not public.pia_is_final_format('number', '3*4'), 'format: expression';

  assert public.pia_format_final('decimal', 0.80) = '0.8',    'format_final: decimal';
  assert public.pia_format_final('percentage', 20) = '20%',   'format_final: percent';

  assert public.pia_step_required(1) = 2 and public.pia_step_required(3) = 3, 'required';
  assert public.pia_step_label(1, 0) = 'Conversion' and public.pia_step_label(3, 2) = 'Conversion', 'labels';
  assert public.pia_step_confirm_kind(1, 0) = 'decimal'
     and public.pia_step_confirm_kind(2, 2) = 'percentage'
     and public.pia_step_confirm_kind(2, 0) = 'number', 'confirm kinds';

end;
$$;

commit;

-- ============================================================================
-- WHAT WAS AND WAS NOT VERIFIED
--   Verified: nothing against a live database -- none was available. The
--   self-test above checks the pure helpers on apply.
--   NOT verified: serve_next_step_question, check_step_answer,
--   consume_step_hint, finish_step_question, respond_topic_offer and the new
--   resume under RLS. The browser side was tested against a mock of these
--   calls only. Before applying for real, on a copy: play a lesson as a
--   student of each group and confirm (a) a control student is refused by
--   every call, (b) no response ever contains a step answer or final_answer,
--   (c) hint is null before two wrong answers, (d) the offers behave as
--   described at the top, and extend 0029's postflight to cover them.
--   Assumed from outside this repo: tutoring_attempts accepts
--   attempts_used / hints_used up to 10 and classification 'smooth' |
--   'struggling' (0029 relies on the same), and trim_scale() exists
--   (PostgreSQL 13+).
-- ============================================================================
