-- PIA 0049: points that mean something, set by the admin.
--
-- BEFORE: finish_step_question wrote step_states.score = 100 (errors < the topic's max) or 50, and
-- question_bank.points (the admin's per-question value) was read by nothing in the game.
-- NOW: question_bank.points is the BASE (maximum) points of the question and the score comes from
--   raw   = base - base*wrong%*wrong_answers - base*hint%*hints_taken
--           + base*fast_bonus%   (only when the speed bonus is on, there was NO wrong answer, and
--                                 the question was finished within the fast threshold)
--   score = max(score_min, round(raw))
--   a repeat of a question already completed in this session: 0, or score*repeat% if enabled.
-- Everything is configurable in app_config (validated by CHECK constraints); the percentages are of
-- the question's own base, so they hold for 10-point and 50-point questions alike.
--
-- THE SERVER DECIDES. The score is computed in finish_step_question from the server's own records
-- (errors, hints, serve time) and saved once (idempotent: a second call returns the stored result).
-- The browser never sends or sees a score.
--
-- NOT TOUCHED: the adaptive topic rules (mastery / min questions / max errors), the PASSED flag,
-- tutoring_attempts, and the learning profile (get_learning_features): points never decide
-- Struggling / Average / Outstanding. Historical scores are never rewritten.
-- served_questions.base_points is stamped by a trigger when a question is served, so changing a
-- question's points affects only questions served afterwards.
begin;

do $$
begin
  if to_regprocedure('public.finish_step_question(uuid, text)') is null
     or to_regclass('public.step_hints') is null then
    raise exception 'PIA 0049 requires the 0039 game (apply 0039 first).';
  end if;
end;
$$;

alter table public.app_config
  add column if not exists score_wrong_pct       int     not null default 20,
  add column if not exists score_hint_pct        int     not null default 10,
  add column if not exists score_fast_bonus_pct  int     not null default 20,
  add column if not exists score_fast_seconds    int     not null default 30,
  add column if not exists score_speed_bonus     boolean not null default true,
  add column if not exists score_min             int     not null default 0,
  add column if not exists score_repeat_enabled  boolean not null default false,
  add column if not exists score_repeat_pct      int     not null default 50;

do $$
begin
  if not exists (select 1 from pg_constraint where conname = 'app_config_score_rules_check') then
    alter table public.app_config add constraint app_config_score_rules_check check (
      score_wrong_pct between 0 and 100 and score_hint_pct between 0 and 100
      and score_fast_bonus_pct between 0 and 100 and score_fast_seconds between 1 and 3600
      and score_min between 0 and 500 and score_repeat_pct between 0 and 100);
  end if;
end;
$$;

alter table public.served_questions add column if not exists base_points int;

create or replace function public.pia_stamp_base_points()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if new.base_points is null then
    select q.points into new.base_points from public.question_bank q where q.id = new.question_id;
  end if;
  return new;
end;
$$;

drop trigger if exists served_questions_base_points on public.served_questions;
create trigger served_questions_base_points
  before insert on public.served_questions
  for each row execute function public.pia_stamp_base_points();

-- The one place the formula lives. Pure apart from reading the admin's rules.
create or replace function public.pia_compute_score(
  p_base int, p_errors int, p_hints int, p_ms bigint, p_repeat_prior int)
returns int
language plpgsql
stable
security definer
set search_path = public
as $$
declare
  c        public.app_config%rowtype;
  v_base   numeric := greatest(0, coalesce(p_base, 0));
  v_raw    numeric;
  v_score  numeric;
begin
  select * into c from public.app_config where id = 1;
  if not found then
    c.score_wrong_pct := 20; c.score_hint_pct := 10; c.score_fast_bonus_pct := 20; c.score_fast_seconds := 30;
    c.score_speed_bonus := true; c.score_min := 0; c.score_repeat_enabled := false; c.score_repeat_pct := 50;
  end if;

  v_raw := v_base
         - v_base * c.score_wrong_pct / 100.0 * greatest(0, coalesce(p_errors, 0))
         - v_base * c.score_hint_pct  / 100.0 * greatest(0, coalesce(p_hints, 0));
  -- Speed only ever ADDS, and only to a question with no wrong answer. Slow answers lose nothing.
  if c.score_speed_bonus and coalesce(p_errors, 0) = 0 and p_ms is not null and p_ms >= 0
     and p_ms <= c.score_fast_seconds * 1000::bigint then
    v_raw := v_raw + v_base * c.score_fast_bonus_pct / 100.0;
  end if;
  v_score := greatest(c.score_min, round(v_raw));

  if coalesce(p_repeat_prior, 0) > 0 then
    v_score := case when c.score_repeat_enabled then greatest(0, round(v_score * c.score_repeat_pct / 100.0)) else 0 end;
  end if;
  return v_score::int;
end;
$$;

revoke all on function public.pia_stamp_base_points() from public, anon, authenticated;
revoke all on function public.pia_compute_score(int, int, int, bigint, int) from public, anon, authenticated;

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
  v_repeat_prior int;
  v_hints_taken  int;
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

  -- PASSED stays the game's rule (errors < the topic's max errors). The SCORE is no longer a fixed
  -- 100/50: it comes from this question's base points and the admin's scoring rules (pia_compute_score),
  -- saved once, here, by the server. A repeat of a question already completed in this session
  -- scores per the repeat rule. The hint count is the distinct hints actually taken (step, tier).
  select count(*) into v_repeat_prior
    from public.tutoring_attempts t
    join public.served_questions s
      on s.session_id = t.session_id and s.student_email = t.student_email and s.problem_id = t.problem_id
   where t.session_id = p_session_id and t.student_email = v_email and s.question_id = v_sq.question_id;
  select count(*) into v_hints_taken
    from (select distinct step_index, tier from public.step_hints
           where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id) h;

  update public.step_states
     set passed = (v_st.errors < v_rule.max_err),
         score  = coalesce(score, public.pia_compute_score(
                    coalesce(v_sq.base_points, 10), v_st.errors, v_hints_taken, v_ms, v_repeat_prior))
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;

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

revoke all on function public.finish_step_question(uuid, text) from public, anon;
grant execute on function public.finish_step_question(uuid, text) to authenticated;

commit;
