-- ============================================================================
-- PIA 0029 -- THE TUTORING SESSION SERVES THE PERCENTAGES QUESTION BANK
-- ============================================================================
-- The study topic is Percentages: Topic 1 Finding a percentage (EASY),
-- Topic 2 Percentage increase (MEDIUM), Topic 3 Percentage decrease (HARD).
-- The algebra set (student/js/math-problems.js with math_answers/math_hints)
-- is retired; the student dashboard now takes every question from
-- question_bank (0028), chosen by the server.
--
-- WHAT THE BROWSER CAN AND CANNOT SEE
--   question_bank stays admin-only (0028). Every student call below is a
--   SECURITY DEFINER function, and none of them returns a final answer or a
--   step answer while the question is open:
--     serve_next_question   the problem statement, counts, and the hints the
--                           student has ALREADY taken (so a reload shows them)
--     consume_question_hint the next hint, counted
--     check_question_answer right/wrong and attempts left -- never the key
--     reveal_question_solution  the answer and worked steps, only once the
--                           question is closed (solved, or both tries used)
--   The question is copied into served_questions when it is served, so an
--   admin editing or deleting it mid-lesson cannot change what the student
--   is graded against. That table has no grants at all.
--
-- HINTS: THREE TIERS PER STEP, IN ORDER
--   Step 1 Concept, Setup, Worked calculation; then Step 2 ...; empty tiers are
--   skipped. An older question with only a plain-text hint gives that one
--   hint. Each hint comes with its step's prompt (never its answer). Hints
--   are counted in hint_consumptions exactly as before, so the smooth /
--   struggling classification keeps its meaning.
--
-- TOPIC PROGRESSION: THE ADMIN'S RULES (app_config), NOT THE OLD TREE
--   The algebra "decision tree" (3 smooth -> up, 2 struggling -> down) is not
--   used for these sessions. Instead, after each question:
--     * UP one topic when, in the current topic, the student has SOLVED at
--       least "Solved to level up" (min_questions) questions AND accuracy is
--       at least the mastery threshold (correct / answered, in this topic).
--     * DOWN one topic when wrong answers in the current topic reach "Wrong
--       to level down" (max_errors). On Topic 1 there is nowhere lower, so the
--       count starts afresh instead ('floor_reset').
--     * Up is checked before down. Counting starts over whenever the topic
--       changes. "Correct" = solved within the two tries (hints allowed);
--       "wrong" = both tries used without the answer.
--   Progress belongs to the STUDENT, not to one session: the next session
--   starts on the topic the last one ended on. Every change is logged in
--   topic_changes with the rule values that applied, for the analysis.
--   The smooth/struggling classification is computed and stored exactly as
--   before (correct, no hint, one try, within 30 s).
--
-- ANSWER MATCHING
--   Commas are ignored; when the key holds one number, the answer must hold
--   exactly one number and it must be equal ("25", "25%", "25 %" all match
--   "25%"; "0.25" does not). A key with no number is compared as text.
--
-- LEFT IN PLACE, BUT DISCONNECTED: the algebra functions (serve_problem,
-- consume_hint, reveal_solution, record_problem_result_v2, check_math_answer)
-- and their tables keep their data; signed-in users can no longer call them.
-- Earlier sessions' records are untouched. The teacher monitor (0026) also
-- counts answers from the new attempt table as activity.
--
-- The postflight runs a whole lesson as a real student under RLS -- serve,
-- hint, wrong, right, level up, level down, reveal -- asserting at every step
-- that no answer reaches the browser. Everything it does is rolled back.
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
  foreach t in array array['question_bank', 'app_config', 'problem_serves',
                           'hint_consumptions', 'tutoring_attempts'] loop
    if to_regclass('public.' || t) is null then
      v_problems := v_problems || 'public.' || t || ' is missing; ';
    end if;
  end loop;
  if to_regprocedure('public.start_game_session()') is null then
    v_problems := v_problems || 'start_game_session() is missing; ';
  end if;
  if to_regprocedure('public.teacher_class_status()') is null then
    v_problems := v_problems || 'teacher_class_status() is missing (run 0026 first); ';
  end if;
  if v_problems <> '' then
    raise exception 'PIA 0029 ABORT (nothing changed): %', v_problems using errcode = 'P0001';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 1. Tables. None has a grant: only the functions below touch them, except
--    the two an admin may read for the analysis.
-- ---------------------------------------------------------------------------
create table if not exists public.served_questions (
  session_id     uuid        not null,
  student_email  text        not null,
  problem_id     text        not null,           -- 'qb-<question_bank.id>'
  problem_number int         not null,
  question_id    bigint      not null,
  topic          int         not null,           -- the question's topic
  student_topic  int         not null,           -- the student's topic when served
  question       text        not null,
  final_answer   text        not null,
  steps          jsonb       not null default '[]'::jsonb,
  default_hint   text,
  served_at      timestamptz not null default now(),
  primary key (session_id, problem_id)
);
create index if not exists served_questions_student_idx on public.served_questions (student_email, question_id);

create table if not exists public.question_attempts (
  id             bigint generated always as identity primary key,
  session_id     uuid        not null,
  student_email  text        not null,
  problem_id     text        not null,
  attempt_number int         not null check (attempt_number between 1 and 2),
  submitted      text        not null,
  was_correct    boolean     not null,
  attempted_at   timestamptz not null default now(),
  unique (session_id, student_email, problem_id, attempt_number)
);

create table if not exists public.student_topic_progress (
  student_email  text primary key,
  topic          int  not null default 1 check (topic between 1 and 3),
  stint_answered int  not null default 0,
  stint_correct  int  not null default 0,
  stint_wrong    int  not null default 0,
  updated_at     timestamptz not null default now()
);

create table if not exists public.topic_changes (
  id             bigint generated always as identity primary key,
  student_email  text        not null,
  session_id     uuid,
  problem_number int,
  from_topic     int         not null,
  to_topic       int         not null,
  reason         text        not null,           -- mastered | error_limit | floor_reset
  stint_answered int         not null,
  stint_correct  int         not null,
  stint_wrong    int         not null,
  mastery        int         not null,
  min_solved     int         not null,
  max_errors     int         not null,
  changed_at     timestamptz not null default now()
);
create index if not exists topic_changes_student_idx on public.topic_changes (student_email, changed_at);

alter table public.served_questions       enable row level security;
alter table public.question_attempts      enable row level security;
alter table public.student_topic_progress enable row level security;
alter table public.topic_changes          enable row level security;

revoke all on public.served_questions       from public, anon, authenticated;
revoke all on public.question_attempts      from public, anon, authenticated;
revoke all on public.student_topic_progress from public, anon, authenticated;
revoke all on public.topic_changes          from public, anon, authenticated;

-- Progress and topic changes are research data: readable by admins only.
drop policy if exists student_topic_progress_admin_read on public.student_topic_progress;
create policy student_topic_progress_admin_read on public.student_topic_progress
  for select to authenticated
  using (public.pia_caller_role() = 'admin' and public.jwt_is_current());
drop policy if exists topic_changes_admin_read on public.topic_changes;
create policy topic_changes_admin_read on public.topic_changes
  for select to authenticated
  using (public.pia_caller_role() = 'admin' and public.jwt_is_current());
grant select on public.student_topic_progress to authenticated;
grant select on public.topic_changes          to authenticated;


-- ---------------------------------------------------------------------------
-- 2. Helpers (not callable from the browser)
-- ---------------------------------------------------------------------------

-- question_bank.hint is TEXT holding {"defaultHint", "steps": [...]}; older
-- rows hold a plain sentence.
create or replace function public.pia_parse_hint(p_hint text)
returns jsonb
language plpgsql
immutable
set search_path = public
as $$
declare j jsonb;
begin
  if p_hint is null or trim(p_hint) = '' then
    return jsonb_build_object('defaultHint', '', 'steps', '[]'::jsonb);
  end if;
  begin
    j := p_hint::jsonb;
  exception when others then
    return jsonb_build_object('defaultHint', p_hint, 'steps', '[]'::jsonb);
  end;
  if jsonb_typeof(j) <> 'object' then
    return jsonb_build_object('defaultHint', p_hint, 'steps', '[]'::jsonb);
  end if;
  return jsonb_build_object(
    'defaultHint', coalesce(j ->> 'defaultHint', ''),
    'steps', case when jsonb_typeof(j -> 'steps') = 'array' then j -> 'steps' else '[]'::jsonb end);
end;
$$;

-- The hints of one question, in the order they are given.
create or replace function public.pia_question_hint_list(p_steps jsonb, p_default text)
returns table (idx int, step int, steps_total int, tier int, step_prompt text, hint text)
language plpgsql
immutable
set search_path = public
as $$
declare
  v_steps jsonb := case when jsonb_typeof(p_steps) = 'array' then p_steps else '[]'::jsonb end;
  v_total int;
  v_n     int := 0;
  v_step  jsonb;
  v_text  text;
  i       int;
  t       int;
begin
  v_total := jsonb_array_length(v_steps);
  for i in 0 .. v_total - 1 loop
    v_step := v_steps -> i;
    for t in 1 .. 3 loop
      v_text := nullif(trim(coalesce(v_step ->> ('hint' || t), '')), '');
      if v_text is not null then
        v_n := v_n + 1;
        idx := v_n;
        step := i + 1;
        steps_total := v_total;
        tier := t;
        step_prompt := nullif(trim(coalesce(v_step ->> 'prompt', '')), '');
        hint := v_text;
        return next;
      end if;
    end loop;
  end loop;

  if v_n = 0 and nullif(trim(coalesce(p_default, '')), '') is not null then
    idx := 1; step := null; steps_total := 0; tier := 1; step_prompt := null; hint := trim(p_default);
    return next;
  end if;
end;
$$;

create or replace function public.pia_tier_label(p_tier int)
returns text
language sql
immutable
as $$
  select case p_tier when 1 then 'Concept' when 2 then 'Setup' when 3 then 'Worked calculation' else 'Hint' end;
$$;

-- Does the student's answer match the key? See the header for the rule.
create or replace function public.pia_answer_matches(p_submitted text, p_key text)
returns boolean
language plpgsql
immutable
set search_path = public
as $$
declare
  s      text := replace(lower(coalesce(p_submitted, '')), ',', '');
  k      text := replace(lower(coalesce(p_key, '')), ',', '');
  s_nums text[];
  k_nums text[];
  s_text text;
begin
  select array_agg(m[1]) into s_nums from regexp_matches(s, '(-?[0-9]*\.?[0-9]+)', 'g') as m;
  select array_agg(m[1]) into k_nums from regexp_matches(k, '(-?[0-9]*\.?[0-9]+)', 'g') as m;

  if coalesce(array_length(k_nums, 1), 0) = 1 then
    return coalesce(array_length(s_nums, 1), 0) = 1
       and abs(s_nums[1]::numeric - k_nums[1]::numeric) < 0.000001;
  end if;

  s_text := regexp_replace(s, '[^a-z0-9%.-]', '', 'g');
  return s_text <> '' and s_text = regexp_replace(k, '[^a-z0-9%.-]', '', 'g');
end;
$$;

-- The student's current topic; creates their progress row on first use.
create or replace function public.pia_student_topic(p_email text)
returns int
language plpgsql
set search_path = public
as $$
declare v_topic int;
begin
  insert into public.student_topic_progress (student_email) values (p_email)
  on conflict (student_email) do nothing;
  select topic into v_topic from public.student_topic_progress where student_email = p_email;
  return coalesce(v_topic, 1);
end;
$$;

-- What the browser receives about a served question: never an answer.
create or replace function public.pia_question_payload(p public.served_questions)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  v_total    int;
  v_used     int;
  v_attempts int;
  v_correct  boolean;
  v_hints    jsonb;
begin
  select count(*) into v_total from public.pia_question_hint_list(p.steps, p.default_hint);

  select count(*) into v_used
    from public.hint_consumptions h
   where h.session_id = p.session_id and h.student_email = p.student_email and h.problem_id = p.problem_id;

  select count(*), coalesce(bool_or(a.was_correct), false) into v_attempts, v_correct
    from public.question_attempts a
   where a.session_id = p.session_id and a.student_email = p.student_email and a.problem_id = p.problem_id;

  select coalesce(jsonb_agg(jsonb_build_object(
           'index', l.idx, 'step', l.step, 'steps_total', l.steps_total,
           'tier', l.tier, 'tier_label', public.pia_tier_label(l.tier),
           'step_prompt', l.step_prompt, 'text', l.hint) order by l.idx), '[]'::jsonb)
    into v_hints
    from public.pia_question_hint_list(p.steps, p.default_hint) l
   where l.idx <= v_used;

  return jsonb_build_object(
    'done',            false,
    'problem_id',      p.problem_id,
    'problem_number',  p.problem_number,
    'question',        p.question,
    'topic',           p.student_topic,
    'question_topic',  p.topic,
    'hints_total',     v_total,
    'hints_used',      v_used,
    'hints_left',      greatest(v_total - v_used, 0),
    'hints',           v_hints,
    'attempts_used',   v_attempts,
    'attempts_left',   case when v_correct then 0 else greatest(2 - v_attempts, 0) end,
    'locked',          v_correct or v_attempts >= 2);
end;
$$;

-- The recorded outcome of one question, rebuilt from the stored rows.
create or replace function public.pia_result_payload(p_session_id uuid, p_email text, p_problem_id text)
returns jsonb
language plpgsql
stable
set search_path = public
as $$
declare
  t        record;
  v_reason text;
  v_streak int := 0;
  v_count  int;
  r        record;
begin
  select * into t from public.tutoring_attempts
   where session_id = p_session_id and student_email = p_email and problem_id = p_problem_id;
  if not found then return null; end if;

  select c.reason into v_reason from public.topic_changes c
   where c.session_id = p_session_id and c.student_email = p_email and c.problem_number = t.problem_number
   order by c.id desc limit 1;

  for r in select a.is_correct from public.tutoring_attempts a
            where a.session_id = p_session_id and a.student_email = p_email and a.problem_id like 'qb-%'
            order by a.problem_number desc loop
    exit when not r.is_correct;
    v_streak := v_streak + 1;
  end loop;

  select count(*) into v_count from public.tutoring_attempts a
   where a.session_id = p_session_id and a.student_email = p_email and a.problem_id like 'qb-%';

  return jsonb_build_object(
    'is_correct',        t.is_correct,
    'classification',    t.classification,
    'attempts_used',     t.attempts_used,
    'hints_used',        t.hints_used,
    'time_taken_ms',     t.time_taken_ms,
    'topic_before',      t.level_before,
    'topic',             t.level_after,
    'topic_change',      case when t.level_after > t.level_before then 'up'
                              when t.level_after < t.level_before then 'down' end,
    'reason',            v_reason,
    'streak',            v_streak,
    'problems_answered', v_count);
end;
$$;

revoke all on function public.pia_parse_hint(text)                              from public, anon, authenticated;
revoke all on function public.pia_question_hint_list(jsonb, text)               from public, anon, authenticated;
revoke all on function public.pia_answer_matches(text, text)                    from public, anon, authenticated;
revoke all on function public.pia_student_topic(text)                           from public, anon, authenticated;
revoke all on function public.pia_question_payload(public.served_questions)     from public, anon, authenticated;
revoke all on function public.pia_result_payload(uuid, text, text)              from public, anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. The student's calls
-- ---------------------------------------------------------------------------

-- The next question for this session, picked by the server: the student's
-- topic first, then questions this student has seen least, then at random.
-- A question still open comes back unchanged, so a reload cannot swap a hard
-- question for an easier one.
create or replace function public.serve_next_question(p_session_id uuid)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email    text := auth.jwt() ->> 'email';
  c_target   constant int := 10;       -- SESSION_TARGET in student-dashboard.js
  v_sq       public.served_questions%rowtype;
  v_answered int;
  v_topic    int;
  v_q        record;
  v_parsed   jsonb;
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
  if p_session_id is null then
    raise exception 'PIA: a session is required.' using errcode = '22023';
  end if;

  -- One serve or record at a time per student.
  perform pg_advisory_xact_lock(hashtext('pia-lesson:' || v_email));

  select sq.* into v_sq
    from public.served_questions sq
   where sq.session_id = p_session_id and sq.student_email = v_email
     and not exists (select 1 from public.tutoring_attempts t
                      where t.session_id = sq.session_id and t.student_email = sq.student_email
                        and t.problem_id = sq.problem_id)
   order by sq.problem_number desc
   limit 1;

  if found then
    return public.pia_question_payload(v_sq);
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
     and trim(coalesce(q.final_answer, '')) <> ''
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

  -- The serve stamp that timing (and the teacher monitor) already use.
  insert into public.problem_serves (session_id, student_email, problem_id, problem_number)
  values (p_session_id, v_email, v_sq.problem_id, v_sq.problem_number)
  on conflict (session_id, problem_id) do nothing;

  return public.pia_question_payload(v_sq);
end;
$$;


create or replace function public.check_question_answer(p_session_id uuid, p_problem_id text, p_submitted text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_sub     text := left(trim(coalesce(p_submitted, '')), 60);
  v_sq      public.served_questions%rowtype;
  v_used    int;
  v_ok      boolean;
  v_correct boolean;
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;
  if v_sub = '' then
    raise exception 'PIA: an answer is required.' using errcode = '22023';
  end if;

  perform pg_advisory_xact_lock(hashtext('pia-lesson:' || v_email));

  select * into v_sq from public.served_questions
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;
  if not found then
    raise exception 'PIA: this question was not served to you.' using errcode = '42501';
  end if;

  select count(*), coalesce(bool_or(was_correct), false) into v_used, v_ok
    from public.question_attempts
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;

  -- Closed: solved, both tries used, or already recorded. Nothing is checked.
  if v_ok or v_used >= 2 or exists (
       select 1 from public.tutoring_attempts t
        where t.session_id = p_session_id and t.student_email = v_email and t.problem_id = p_problem_id) then
    return jsonb_build_object('correct', v_ok, 'attempts_used', v_used, 'attempts_left', 0, 'locked', true);
  end if;

  v_correct := public.pia_answer_matches(v_sub, v_sq.final_answer);

  insert into public.question_attempts (session_id, student_email, problem_id, attempt_number, submitted, was_correct)
  values (p_session_id, v_email, p_problem_id, v_used + 1, v_sub, v_correct);

  return jsonb_build_object(
    'correct',       v_correct,
    'attempts_used', v_used + 1,
    'attempts_left', case when v_correct then 0 else greatest(1 - v_used, 0) end,
    'locked',        v_correct or v_used + 1 >= 2);
end;
$$;


create or replace function public.consume_question_hint(p_session_id uuid, p_problem_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text := auth.jwt() ->> 'email';
  v_sq    public.served_questions%rowtype;
  v_total int;
  v_used  int;
  v_att   int;
  v_ok    boolean;
  l       record;
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('pia-lesson:' || v_email));

  select * into v_sq from public.served_questions
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;
  if not found then
    raise exception 'PIA: this question was not served to you.' using errcode = '42501';
  end if;

  select count(*) into v_used from public.hint_consumptions
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;
  select count(*) into v_total from public.pia_question_hint_list(v_sq.steps, v_sq.default_hint);

  select count(*), coalesce(bool_or(was_correct), false) into v_att, v_ok
    from public.question_attempts
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;

  -- A closed question takes no more hints; its worked solution comes from
  -- reveal_question_solution().
  if v_ok or v_att >= 2 then
    return jsonb_build_object('hint', null, 'hints_used', v_used, 'hints_left', 0,
                              'exhausted', true, 'locked', true);
  end if;

  if v_used >= v_total then
    return jsonb_build_object('hint', null, 'hints_used', v_used, 'hints_left', 0,
                              'exhausted', true, 'locked', false);
  end if;

  select * into l from public.pia_question_hint_list(v_sq.steps, v_sq.default_hint) h
   where h.idx = v_used + 1;

  insert into public.hint_consumptions (session_id, student_email, problem_id, hint_index)
  values (p_session_id, v_email, p_problem_id, v_used + 1)
  on conflict do nothing;

  return jsonb_build_object(
    'hint', jsonb_build_object(
      'index', l.idx, 'step', l.step, 'steps_total', l.steps_total,
      'tier', l.tier, 'tier_label', public.pia_tier_label(l.tier),
      'step_prompt', l.step_prompt, 'text', l.hint),
    'hints_used', v_used + 1,
    'hints_left', v_total - v_used - 1,
    'exhausted',  v_used + 1 >= v_total,
    'locked',     false);
end;
$$;


create or replace function public.reveal_question_solution(p_session_id uuid, p_problem_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email text := auth.jwt() ->> 'email';
  v_sq    public.served_questions%rowtype;
  v_att   int;
  v_ok    boolean;
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;

  select * into v_sq from public.served_questions
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;
  if not found then
    raise exception 'PIA: this question was not served to you.' using errcode = '42501';
  end if;

  select count(*), coalesce(bool_or(was_correct), false) into v_att, v_ok
    from public.question_attempts
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;

  -- The gate: without it this would be the answer leak.
  if not (v_ok or v_att >= 2) then
    raise exception 'PIA: this question is not finished yet.' using errcode = '42501';
  end if;

  return jsonb_build_object(
    'final_answer', v_sq.final_answer,
    'steps', (select coalesce(jsonb_agg(jsonb_build_object(
                       'step', e.ord, 'prompt', e.s ->> 'prompt',
                       'answer', e.s ->> 'answer', 'worked', e.s ->> 'hint3') order by e.ord), '[]'::jsonb)
                from jsonb_array_elements(v_sq.steps) with ordinality as e(s, ord)));
end;
$$;


-- Records a closed question -- everything derived on the server -- and
-- applies the topic rules. Safe to call twice: the second call returns the
-- first result.
create or replace function public.record_question_result(p_session_id uuid, p_problem_id text)
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_sq      public.served_questions%rowtype;
  v_att     int;
  v_ok      boolean;
  v_last    timestamptz;
  v_hints   int;
  v_served  timestamptz;
  v_ms      bigint;
  v_class   text;
  v_cfg     public.app_config%rowtype;
  v_prog    public.student_topic_progress%rowtype;
  v_mastery int;
  v_min     int;
  v_maxerr  int;
  v_from    int;
  v_to      int;
  v_reason  text;
  v_a       int;
  v_c       int;
  v_w       int;
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;

  perform pg_advisory_xact_lock(hashtext('pia-lesson:' || v_email));

  select * into v_sq from public.served_questions
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;
  if not found then
    raise exception 'PIA: this question was not served to you.' using errcode = '42501';
  end if;

  if exists (select 1 from public.tutoring_attempts
              where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id) then
    return public.pia_result_payload(p_session_id, v_email, p_problem_id);
  end if;

  -- (a) Attempts and correctness -- written only by check_question_answer.
  select count(*), coalesce(bool_or(was_correct), false), max(attempted_at)
    into v_att, v_ok, v_last
    from public.question_attempts
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;

  if not (v_ok or v_att >= 2) then
    raise exception 'PIA: answer this question first.' using errcode = '42501';
  end if;

  -- (b) Hints -- the server's own count.
  select count(*) into v_hints from public.hint_consumptions
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;

  -- (c) Time -- from the serve stamp, never the browser's clock.
  select served_at into v_served from public.problem_serves
   where session_id = p_session_id and problem_id = p_problem_id;
  if v_served is null then
    raise exception 'PIA: this question was not served.' using errcode = '42501';
  end if;
  v_ms := greatest(0, least(3600000,
            (extract(epoch from (coalesce(v_last, now()) - v_served)) * 1000)::bigint));

  -- (d) Classification -- the same rule as every earlier session.
  v_class := case when v_ok and v_hints = 0 and v_att <= 1 and v_ms <= 30000
                  then 'smooth' else 'struggling' end;

  -- (e) Topic -- the admin's rules for the student's CURRENT topic.
  select * into v_cfg from public.app_config where id = 1;

  insert into public.student_topic_progress (student_email) values (v_email)
  on conflict (student_email) do nothing;
  select * into v_prog from public.student_topic_progress where student_email = v_email for update;

  v_from := v_prog.topic;
  v_a := v_prog.stint_answered + 1;
  v_c := v_prog.stint_correct + case when v_ok then 1 else 0 end;
  v_w := v_prog.stint_wrong + case when v_ok then 0 else 1 end;

  v_mastery := coalesce(case v_from when 1 then v_cfg.easy_mastery
                                    when 2 then v_cfg.medium_mastery
                                    else v_cfg.hard_mastery end, 80);
  v_min     := coalesce(case v_from when 1 then v_cfg.easy_min_questions
                                    when 2 then v_cfg.medium_min_questions
                                    else v_cfg.hard_min_questions end, 3);
  v_maxerr  := coalesce(case v_from when 1 then v_cfg.easy_max_errors
                                    when 2 then v_cfg.medium_max_errors
                                    else v_cfg.hard_max_errors end, 3);

  v_to := v_from;
  v_reason := null;
  if v_from < 3 and v_c >= v_min and v_c * 100 >= v_mastery * v_a then
    v_to := v_from + 1;
    v_reason := 'mastered';
  elsif v_w >= v_maxerr then
    if v_from > 1 then
      v_to := v_from - 1;
      v_reason := 'error_limit';
    else
      v_reason := 'floor_reset';
    end if;
  end if;

  if v_reason is not null then
    insert into public.topic_changes (
      student_email, session_id, problem_number, from_topic, to_topic, reason,
      stint_answered, stint_correct, stint_wrong, mastery, min_solved, max_errors)
    values (
      v_email, p_session_id, v_sq.problem_number, v_from, v_to, v_reason,
      v_a, v_c, v_w, v_mastery, v_min, v_maxerr);

    update public.student_topic_progress
       set topic = v_to, stint_answered = 0, stint_correct = 0, stint_wrong = 0, updated_at = now()
     where student_email = v_email;
  else
    update public.student_topic_progress
       set stint_answered = v_a, stint_correct = v_c, stint_wrong = v_w, updated_at = now()
     where student_email = v_email;
  end if;

  -- level_before / level_after now hold the TOPIC (1-3) for these rows.
  insert into public.tutoring_attempts (
    session_id, student_email, problem_id, problem_number,
    level_before, level_after, attempts_used, hints_used,
    time_taken_ms, is_correct, classification)
  values (
    p_session_id, v_email, p_problem_id, v_sq.problem_number,
    v_from, v_to, least(10, v_att), least(10, v_hints),
    v_ms, v_ok, v_class)
  on conflict (session_id, problem_number) do nothing;

  return public.pia_result_payload(p_session_id, v_email, p_problem_id);
end;
$$;


-- Resume only a PERCENTAGES session: an unfinished algebra session is left
-- where it is, and the student starts fresh.
create or replace function public.resume_or_start_game_session()
returns jsonb
language plpgsql
security definer
set search_path = public, extensions
as $$
declare
  v_email    text := auth.jwt() ->> 'email';
  v_session  uuid;
  v_answered int;
  v_correct  int;
  v_pending  text;
  v_streak   int := 0;
  r          record;
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;
  if not public.jwt_is_current() then
    raise exception 'PIA: this session was signed out. Please sign in again.' using errcode = '42501';
  end if;

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

      -- Time away is not time on task (as in 0016): the open question's
      -- clock restarts when the student comes back.
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

revoke all on function public.serve_next_question(uuid)                   from public, anon;
revoke all on function public.check_question_answer(uuid, text, text)     from public, anon;
revoke all on function public.consume_question_hint(uuid, text)           from public, anon;
revoke all on function public.reveal_question_solution(uuid, text)        from public, anon;
revoke all on function public.record_question_result(uuid, text)          from public, anon;
revoke all on function public.resume_or_start_game_session()              from public, anon;
grant execute on function public.serve_next_question(uuid)                to authenticated;
grant execute on function public.check_question_answer(uuid, text, text)  to authenticated;
grant execute on function public.consume_question_hint(uuid, text)        to authenticated;
grant execute on function public.reveal_question_solution(uuid, text)     to authenticated;
grant execute on function public.record_question_result(uuid, text)       to authenticated;
grant execute on function public.resume_or_start_game_session()           to authenticated;


-- ---------------------------------------------------------------------------
-- 4. Teacher monitor: answers in question_attempts count as activity.
--    Edited IN PLACE from the live definition (as 0022 did), one subquery
--    added; nothing else in it changes.
-- ---------------------------------------------------------------------------
do $$
declare
  v_def    text := pg_get_functiondef('public.teacher_class_status()'::regprocedure);
  v_anchor text := '(select max(h.consumed_at) from public.hint_consumptions h';
  v_new    text;
begin
  if position('question_attempts' in v_def) > 0 then
    raise notice 'PIA 0029: teacher_class_status already reads question_attempts.';
    return;
  end if;
  if position(v_anchor in v_def) = 0 then
    raise exception 'PIA 0029 ABORT: teacher_class_status has changed shape; cannot add the new activity source.'
      using errcode = 'P0001';
  end if;

  v_new := replace(v_def, v_anchor,
    '(select max(q.attempted_at) from public.question_attempts q' || chr(10) ||
    '                 where q.session_id = v_session and lower(q.student_email) = lower(r.email)),' || chr(10) ||
    '               ' || v_anchor);
  execute v_new;
  raise notice 'PIA 0029: teacher_class_status now counts answers from question_attempts.';
end;
$$;


-- ---------------------------------------------------------------------------
-- 5. Disconnect the algebra set. The functions and their data stay; the
--    browser can no longer call them.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.proname in ('serve_problem', 'consume_hint', 'reveal_solution',
                         'record_problem_result_v2', 'check_math_answer')
  loop
    execute format('revoke all on function %s from public, anon, authenticated', r.sig);
    raise notice 'PIA 0029: % is no longer callable from the browser.', r.sig;
  end loop;
end;
$$;


-- ---------------------------------------------------------------------------
-- POSTFLIGHT -- a whole lesson as a real student, rolled back.
-- ---------------------------------------------------------------------------
do $$
declare
  v_student text;
  v_uid     uuid;
  v_iat     bigint := extract(epoch from clock_timestamp())::bigint + 5;
  v_sid     uuid   := gen_random_uuid();
  v_p       jsonb;
  v_r       jsonb;
  v_h       jsonb;
  v_c       jsonb;
  v_pid     text;
  v_steps   text := '[{"prompt":"PIA probe step","answer":"0.4725","hint1":"probe concept","hint2":"probe setup","hint3":"probe worked"}]';
  i         int;
  v_blocked boolean;
begin
  foreach v_pid in array array['public.serve_next_question(uuid)', 'public.check_question_answer(uuid,text,text)',
                               'public.consume_question_hint(uuid,text)', 'public.reveal_question_solution(uuid,text)',
                               'public.record_question_result(uuid,text)'] loop
    if has_function_privilege('anon', v_pid, 'EXECUTE') then
      raise exception 'PIA 0029 ABORT: % is callable without signing in.', v_pid using errcode = 'P0001';
    end if;
  end loop;
  if has_function_privilege('authenticated', 'public.pia_question_payload(public.served_questions)', 'EXECUTE') then
    raise exception 'PIA 0029 ABORT: an internal helper is callable from the browser.' using errcode = 'P0001';
  end if;

  select p.email, u.id into v_student, v_uid
    from public.profiles p join auth.users u on lower(u.email) = lower(p.email)
   where lower(trim(coalesce(p.role, 'student'))) = 'student'
   order by p.email limit 1;

  if v_student is null then
    raise notice 'PIA 0029: no student with a sign-in account to rehearse with -- skipped.';
    return;
  end if;

  begin
    -- A known bank and known rules, for the rehearsal only.
    delete from public.question_bank;
    for i in 1 .. 3 loop
      insert into public.question_bank (difficulty, question, final_answer, hint, points)
      values ('EASY',   'PIA-0029 probe, topic one, number ' || i || '.',   '47.25%',
              '{"defaultHint":"probe concept","steps":' || v_steps || '}', 10),
             ('MEDIUM', 'PIA-0029 probe, topic two, number ' || i || '.',   '47.25%',
              '{"defaultHint":"probe concept","steps":' || v_steps || '}', 10);
    end loop;
    insert into public.app_config (id) values (1) on conflict (id) do nothing;
    update public.app_config
       set easy_mastery = 80, easy_min_questions = 3, easy_max_errors = 3,
           medium_mastery = 80, medium_min_questions = 3, medium_max_errors = 3
     where id = 1;
    delete from public.student_topic_progress where student_email = v_student;

    perform set_config('request.jwt.claims', json_build_object(
      'email', v_student, 'sub', v_uid, 'role', 'authenticated',
      'iat', v_iat, 'session_id', gen_random_uuid())::text, true);
    execute 'set local role authenticated';

    -- The snapshot and attempt tables are closed to the student.
    v_blocked := false;
    begin
      perform count(*) from public.served_questions;
    exception when insufficient_privilege then v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'PIA 0029 ABORT: a student can read served_questions. Rolling back.' using errcode = 'P0001';
    end if;

    -- Q1: served in topic 1, with no answer anywhere in what comes back.
    v_p := public.serve_next_question(v_sid);
    if (v_p ->> 'done')::boolean or (v_p ->> 'question_topic') <> '1' then
      raise exception 'PIA 0029 ABORT: the first question was not a topic 1 question: %', v_p using errcode = 'P0001';
    end if;
    if v_p::text ~ '47\.25|0\.4725' then
      raise exception 'PIA 0029 ABORT: an answer reached the browser in serve_next_question: %', v_p using errcode = 'P0001';
    end if;
    v_pid := v_p ->> 'problem_id';

    if public.serve_next_question(v_sid) ->> 'problem_id' <> v_pid then
      raise exception 'PIA 0029 ABORT: asking again swapped the open question. Rolling back.' using errcode = 'P0001';
    end if;

    v_h := public.consume_question_hint(v_sid, v_pid);
    if v_h -> 'hint' ->> 'tier' <> '1' or v_h -> 'hint' ->> 'text' <> 'probe concept' or v_h::text ~ '47\.25|0\.4725' then
      raise exception 'PIA 0029 ABORT: the first hint is wrong or leaks an answer: %', v_h using errcode = 'P0001';
    end if;
    if public.serve_next_question(v_sid)::text ~ '47\.25|0\.4725' then
      raise exception 'PIA 0029 ABORT: an answer reached the browser after a hint. Rolling back.' using errcode = 'P0001';
    end if;

    v_blocked := false;
    begin
      perform public.reveal_question_solution(v_sid, v_pid);
    exception when insufficient_privilege then v_blocked := true;
    end;
    if not v_blocked then
      raise exception 'PIA 0029 ABORT: the solution was revealed before the question closed. Rolling back.' using errcode = 'P0001';
    end if;

    v_c := public.check_question_answer(v_sid, v_pid, '12');
    if (v_c ->> 'correct')::boolean or (v_c ->> 'attempts_left') <> '1' or v_c::text ~ '47\.25|0\.4725' then
      raise exception 'PIA 0029 ABORT: a wrong answer was handled wrongly: %', v_c using errcode = 'P0001';
    end if;
    v_c := public.check_question_answer(v_sid, v_pid, ' 47.25 ');
    if not (v_c ->> 'correct')::boolean then
      raise exception 'PIA 0029 ABORT: "47.25" did not match the key "47.25%%": %', v_c using errcode = 'P0001';
    end if;
    v_r := public.record_question_result(v_sid, v_pid);
    if not (v_r ->> 'is_correct')::boolean or v_r ->> 'classification' <> 'struggling' or v_r ->> 'topic' <> '1' then
      raise exception 'PIA 0029 ABORT: question 1 was recorded wrongly: %', v_r using errcode = 'P0001';
    end if;
    if public.record_question_result(v_sid, v_pid) ->> 'topic' <> '1' then
      raise exception 'PIA 0029 ABORT: recording twice changed the result. Rolling back.' using errcode = 'P0001';
    end if;

    -- Q2, Q3: right first time -> 3 solved, 100% >= 80% -> topic 2.
    for i in 2 .. 3 loop
      v_p := public.serve_next_question(v_sid);
      if (v_p ->> 'question_topic') <> '1' then
        raise exception 'PIA 0029 ABORT: question % was not topic 1: %', i, v_p using errcode = 'P0001';
      end if;
      v_pid := v_p ->> 'problem_id';
      perform public.check_question_answer(v_sid, v_pid, '47.25%');
      v_r := public.record_question_result(v_sid, v_pid);
    end loop;
    if v_r ->> 'topic' <> '2' or v_r ->> 'topic_change' <> 'up' or v_r ->> 'reason' <> 'mastered' then
      raise exception 'PIA 0029 ABORT: mastering topic 1 did not move the student up: %', v_r using errcode = 'P0001';
    end if;

    -- Q4-Q6: topic 2, both tries wrong each time -> 3 wrong -> back to topic 1.
    for i in 4 .. 6 loop
      v_p := public.serve_next_question(v_sid);
      if (v_p ->> 'question_topic') <> '2' then
        raise exception 'PIA 0029 ABORT: question % was not topic 2: %', i, v_p using errcode = 'P0001';
      end if;
      v_pid := v_p ->> 'problem_id';
      perform public.check_question_answer(v_sid, v_pid, '1');
      perform public.check_question_answer(v_sid, v_pid, '2');
      v_c := public.check_question_answer(v_sid, v_pid, '47.25');
      if not (v_c ->> 'locked')::boolean or (v_c ->> 'correct')::boolean then
        raise exception 'PIA 0029 ABORT: a third try was checked: %', v_c using errcode = 'P0001';
      end if;
      v_r := public.record_question_result(v_sid, v_pid);
    end loop;
    if v_r ->> 'topic' <> '1' or v_r ->> 'topic_change' <> 'down' or v_r ->> 'reason' <> 'error_limit' then
      raise exception 'PIA 0029 ABORT: three wrong answers in topic 2 did not move the student down: %', v_r using errcode = 'P0001';
    end if;

    -- Closed: now the worked solution may be shown.
    v_r := public.reveal_question_solution(v_sid, v_pid);
    if v_r ->> 'final_answer' <> '47.25%' then
      raise exception 'PIA 0029 ABORT: the closed question did not reveal its answer: %', v_r using errcode = 'P0001';
    end if;

    execute 'reset role';
    raise exception 'rehearsal done' using errcode = 'P0002';
  exception
    when sqlstate 'P0002' then
      raise notice 'PIA 0029 OK: a full lesson ran as a real student -- no answer reached the browser, topic 1 -> 2 on mastery, 2 -> 1 on the error limit.';
  end;

  perform set_config('request.jwt.claims', '', true);
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Report
select p.oid::regprocedure::text as function,
       case when has_function_privilege('authenticated', p.oid, 'EXECUTE')
            then 'callable by signed-in users' else 'locked' end as browser_access
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public'
   and p.proname in ('serve_next_question', 'check_question_answer', 'consume_question_hint',
                     'reveal_question_solution', 'record_question_result', 'resume_or_start_game_session',
                     'serve_problem', 'consume_hint', 'reveal_solution', 'record_problem_result_v2',
                     'check_math_answer')
 order by 2, 1;
