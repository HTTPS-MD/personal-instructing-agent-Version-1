-- ============================================================================
-- PIA 0004 -- SERVER-OWNED TUTORING TELEMETRY   (fixes HIGH 1 at HIGH 2)
-- ============================================================================
-- HIGH 1: ang record_problem_result ay tumatanggap ng p_classification,
--   p_hints_used, p_time_taken_ms, p_level_before/after mula sa BROWSER. Tama
--   na ang is_correct ay muling sinusuri laban sa answer key -- pero ang
--   'smooth' vs 'struggling' na label ay MISMONG finding ng thesis, at ang
--   browser ang nagde-deklara nito. Isang linya sa console:
--     await supabaseClient.rpc('record_problem_result', {..., p_classification:'smooth', p_hints_used:0, p_time_taken_ms:1200})
--
-- HIGH 2: ang mga hint ay nasa client (math-problems.js), at ang huling hint
--   ay ang mismong solusyon ('x = 40 - 15'). Kaya (a) nababasa lahat ng sagot
--   sa view-source, at (b) ang pagbabasa nila sa ganoong paraan ay HINDI
--   nagpapataas ng hints_used -- kaya naitatala pa rin silang 'smooth'.
--   Tahimik nitong pinapataas ang performance ng experimental group.
--
-- Solusyon: ang server na ang may-ari ng hints, ng timing, at ng buong
-- Decision Tree. Ang browser ay nagsasabi na lang ng "nasa problem X ako" at
-- "tapos na ako dito" -- wala na itong maide-deklarang anumang sukatan.
-- ============================================================================


-- ---------------------------------------------------------------------------
-- 1. HINTS -- inilipat mula sa client patungo sa DB
-- ---------------------------------------------------------------------------
create table if not exists public.math_hints (
  problem_id text    not null,
  hint_index int     not null check (hint_index >= 1),
  hint_text  text    not null,
  primary key (problem_id, hint_index)
);

-- WALANG select grant: ang consume_hint()/reveal_solution() lang ang
-- nakakabasa nito. Ganito rin ang math_answers -- hindi ito naaabot ng client.
alter table public.math_hints enable row level security;
revoke all on public.math_hints from anon, authenticated;


create table if not exists public.hint_consumptions (
  id            bigint generated always as identity primary key,
  session_id    uuid    not null,
  student_email text    not null,
  problem_id    text    not null,
  hint_index    int     not null,
  consumed_at   timestamptz not null default now(),
  unique (session_id, student_email, problem_id, hint_index)
);

create index if not exists hint_consumptions_lookup_idx
  on public.hint_consumptions (student_email, session_id, problem_id);

alter table public.hint_consumptions enable row level security;
revoke all on public.hint_consumptions from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 2. SERVE TIMESTAMPS -- para hindi na ang browser ang magsabi ng oras
-- ---------------------------------------------------------------------------
create table if not exists public.problem_serves (
  session_id     uuid    not null,
  student_email  text    not null,
  problem_id     text    not null,
  problem_number int     not null,
  served_at      timestamptz not null default now(),
  primary key (session_id, problem_id)
);

alter table public.problem_serves enable row level security;
revoke all on public.problem_serves from anon, authenticated;


-- ---------------------------------------------------------------------------
-- 3. DECISION TREE -- iisang implementasyon, nasa server
--    'smooth'     -> consecutive_correct++, +1 level kada 3 (max 3)
--    'struggling' -> struggling streak++,   -1 level kada 2 (min 1)
--    Eksaktong port ng applyDecisionTree() sa tutoring-dashboard.js.
-- ---------------------------------------------------------------------------
create or replace function public.pia_replay_decision_tree(p_classifications text[])
returns jsonb
language plpgsql
immutable
as $$
declare
  v_level int := 1;
  v_cc    int := 0;
  v_ss    int := 0;
  c       text;
begin
  foreach c in array coalesce(p_classifications, array[]::text[]) loop
    if c = 'smooth' then
      v_cc := v_cc + 1;
      v_ss := 0;
      if v_cc >= 3 and v_level < 3 then
        v_level := v_level + 1;
        v_cc := 0;
      end if;
    else
      v_cc := 0;
      v_ss := v_ss + 1;
      if v_ss >= 2 and v_level > 1 then
        v_level := v_level - 1;
        v_ss := 0;
      end if;
    end if;
  end loop;

  return jsonb_build_object('level', v_level, 'consecutive_correct', v_cc, 'struggling_streak', v_ss);
end;
$$;


-- Ang kasalukuyang estado ng isang session, buo mula sa naitalang kasaysayan.
create or replace function public.pia_session_state(p_session_id uuid, p_email text)
returns jsonb
language sql
stable
as $$
  select public.pia_replay_decision_tree(
    coalesce(array_agg(t.classification order by t.problem_number), array[]::text[]))
  from public.tutoring_attempts t
  where t.session_id = p_session_id and t.student_email = p_email;
$$;


-- ---------------------------------------------------------------------------
-- 4. serve_problem() -- tinatatakan ang oras, ibinibigay ang authoritative level
-- ---------------------------------------------------------------------------
create or replace function public.serve_problem(
  p_session_id uuid, p_problem_id text, p_problem_number int)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := auth.jwt() ->> 'email';
  v_state jsonb;
  v_hints int;
begin
  if v_email is null then
    raise exception 'PIA: walang authenticated session.' using errcode = '42501';
  end if;

  if not exists (select 1 from public.math_answers where problem_id = p_problem_id) then
    raise exception 'PIA: hindi kilalang problem_id: %', p_problem_id using errcode = '22023';
  end if;

  -- Ang UNANG serve lang ang tumatatak ng oras. Ang pag-refresh ng page ay
  -- hindi nagre-reset ng orasan -- kung hindi, libre ang dagdag na oras.
  insert into public.problem_serves (session_id, student_email, problem_id, problem_number)
  values (p_session_id, v_email, p_problem_id, greatest(1, least(50, p_problem_number)))
  on conflict (session_id, problem_id) do nothing;

  select count(*) into v_hints from public.math_hints where problem_id = p_problem_id;
  v_state := public.pia_session_state(p_session_id, v_email);

  return jsonb_build_object(
    'level',               v_state ->> 'level',
    'consecutive_correct', v_state ->> 'consecutive_correct',
    'hints_available',     v_hints);
end;
$$;

revoke all on function public.serve_problem(uuid, text, int) from public, anon;
grant execute on function public.serve_problem(uuid, text, int) to authenticated;


-- ---------------------------------------------------------------------------
-- 5. consume_hint() -- ang hint text ay galing sa DB, at BINIBILANG ng server
-- ---------------------------------------------------------------------------
create or replace function public.consume_hint(p_session_id uuid, p_problem_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email text := auth.jwt() ->> 'email';
  v_used  int;
  v_total int;
  v_next  int;
  v_text  text;
begin
  if v_email is null then
    raise exception 'PIA: walang authenticated session.' using errcode = '42501';
  end if;

  select count(*) into v_total from public.math_hints where problem_id = p_problem_id;
  if v_total = 0 then
    raise exception 'PIA: walang hint para sa problem na ito.' using errcode = '22023';
  end if;

  select count(*) into v_used
    from public.hint_consumptions
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;

  if v_used >= v_total then
    return jsonb_build_object('hint_text', null, 'hints_used', v_used,
                              'hints_left', 0, 'exhausted', true);
  end if;

  v_next := v_used + 1;
  select hint_text into v_text
    from public.math_hints where problem_id = p_problem_id and hint_index = v_next;

  insert into public.hint_consumptions (session_id, student_email, problem_id, hint_index)
  values (p_session_id, v_email, p_problem_id, v_next)
  on conflict do nothing;

  return jsonb_build_object('hint_text', v_text, 'hints_used', v_next,
                            'hints_left', v_total - v_next,
                            'exhausted', v_next >= v_total);
end;
$$;

revoke all on function public.consume_hint(uuid, text) from public, anon;
grant execute on function public.consume_hint(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 6. reveal_solution() -- ang huling hint, PAGKATAPOS lang malock ang problema
--    Hindi ito binibilang bilang hint: resolba na ang problema sa puntong ito.
--    Ang gate ang mahalaga -- kung wala ito, ito na ang bagong answer leak.
-- ---------------------------------------------------------------------------
create or replace function public.reveal_solution(p_session_id uuid, p_problem_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email  text := auth.jwt() ->> 'email';
  v_used   int;
  v_ok     boolean;
  v_text   text;
begin
  if v_email is null then
    raise exception 'PIA: walang authenticated session.' using errcode = '42501';
  end if;

  select count(*), coalesce(bool_or(was_correct), false) into v_used, v_ok
    from public.math_attempt_log
   where student_email = v_email and session_id = p_session_id and problem_id = p_problem_id;

  -- Katulad ng lock rule ng check_math_answer: tama na, o ubos na ang 2 attempts.
  if not (v_ok or v_used >= 2) then
    raise exception 'PIA: hindi pa tapos ang problemang ito.' using errcode = '42501';
  end if;

  select hint_text into v_text
    from public.math_hints where problem_id = p_problem_id order by hint_index desc limit 1;

  return jsonb_build_object('solution', v_text);
end;
$$;

revoke all on function public.reveal_solution(uuid, text) from public, anon;
grant execute on function public.reveal_solution(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 7. record_problem_result_v2() -- LAHAT ay derived, WALANG client input
--    Dalawang argumento lang: aling session, aling problem. Wala nang ibang
--    masasabi ang browser tungkol sa performance ng estudyante.
-- ---------------------------------------------------------------------------
create or replace function public.record_problem_result_v2(p_session_id uuid, p_problem_id text)
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email    text := auth.jwt() ->> 'email';
  v_attempts int;
  v_correct  boolean;
  v_hints    int;
  v_served   timestamptz;
  v_last     timestamptz;
  v_ms       bigint;
  v_number   int;
  v_class    text;
  v_before   jsonb;
  v_after    jsonb;
  v_smooth   boolean;
begin
  if v_email is null then
    raise exception 'PIA: walang authenticated session.' using errcode = '42501';
  end if;

  -- (a) Attempts at pagkatama -- mula sa math_attempt_log, isinulat mismo ng
  --     check_math_answer. Hindi ito naaabot ng client.
  select count(*), coalesce(bool_or(was_correct), false), max(attempted_at)
    into v_attempts, v_correct, v_last
    from public.math_attempt_log
   where student_email = v_email and session_id = p_session_id and problem_id = p_problem_id;

  -- (b) Hints -- server-owned counter, hindi na ang p_hints_used ng browser.
  select count(*) into v_hints
    from public.hint_consumptions
   where session_id = p_session_id and student_email = v_email and problem_id = p_problem_id;

  -- (c) Timing -- mula sa serve stamp, hindi sa Date.now() ng browser.
  select served_at, problem_number into v_served, v_number
    from public.problem_serves
   where session_id = p_session_id and problem_id = p_problem_id;

  if v_served is null then
    raise exception 'PIA: hindi pa naiseserve ang problemang ito.' using errcode = '42501';
  end if;

  v_ms := greatest(0, least(3600000,
            (extract(epoch from (coalesce(v_last, now()) - v_served)) * 1000)::bigint));

  -- (d) Classification -- eksaktong rule ng tutoring-dashboard.js, sa server:
  --     smooth = tama, walang hint, walang retry, at <= 30s.
  v_smooth := v_correct and v_hints = 0 and v_attempts <= 1 and v_ms <= 30000;
  v_class  := case when v_smooth then 'smooth' else 'struggling' end;

  -- (e) Level -- ni-replay mula sa naitalang kasaysayan ng session.
  v_before := public.pia_session_state(p_session_id, v_email);
  v_after  := public.pia_replay_decision_tree(
                (select coalesce(array_agg(t.classification order by t.problem_number), array[]::text[])
                   from public.tutoring_attempts t
                  where t.session_id = p_session_id and t.student_email = v_email)
                || array[v_class]);

  insert into public.tutoring_attempts (
    session_id, student_email, problem_id, problem_number,
    level_before, level_after, attempts_used, hints_used,
    time_taken_ms, is_correct, classification)
  values (
    p_session_id, v_email, p_problem_id, coalesce(v_number, 1),
    (v_before ->> 'level')::int, (v_after ->> 'level')::int,
    least(10, v_attempts), least(10, v_hints),
    v_ms, v_correct, v_class)
  on conflict (session_id, problem_number) do nothing;

  return jsonb_build_object(
    'is_correct',          v_correct,
    'classification',      v_class,
    'attempts_used',       v_attempts,
    'hints_used',          v_hints,
    'time_taken_ms',       v_ms,
    'level_before',        (v_before ->> 'level')::int,
    'level',               (v_after ->> 'level')::int,
    'consecutive_correct', (v_after ->> 'consecutive_correct')::int,
    'levelled_up',         (v_after ->> 'level')::int > (v_before ->> 'level')::int);
end;
$$;

revoke all on function public.record_problem_result_v2(uuid, text) from public, anon;
grant execute on function public.record_problem_result_v2(uuid, text) to authenticated;


-- ---------------------------------------------------------------------------
-- 8. Isara ang lumang forgeable RPC.
--    Hindi ito dini-drop (baka may naitalang data na naka-depende sa signature),
--    inaalis lang ang karapatang tawagin ito mula sa browser. Dynamic ang
--    paghahanap ng signature para hindi ko kailangang hulaan ang arg types.
-- ---------------------------------------------------------------------------
do $$
declare r record;
begin
  for r in
    select p.oid::regprocedure as sig
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public' and p.proname = 'record_problem_result'
  loop
    execute format('revoke all on function %s from authenticated, anon, public', r.sig);
    raise notice 'PIA: naialis ang execute sa lumang %', r.sig;
  end loop;
end;
$$;
insert into public.math_hints (problem_id, hint_index, hint_text) values
  ('l1-1', 1, 'Alisin ang +15 sa magkabilang panig ng equation.'),
  ('l1-1', 2, 'x = 40 - 15'),
  ('l1-2', 1, 'Idagdag ang 8 sa magkabilang panig.'),
  ('l1-2', 2, 'x = 12 + 8'),
  ('l1-3', 1, 'Hatiin ang magkabilang panig ng 3.'),
  ('l1-3', 2, 'x = 21 ÷ 3'),
  ('l1-4', 1, 'I-multiply ang magkabilang panig ng 4.'),
  ('l1-4', 2, 'x = 6 × 4'),
  ('l1-5', 1, 'Alisin muna ang +5: 2x = 17 - 5.'),
  ('l1-5', 2, '2x = 12, kaya x = 12 ÷ 2'),
  ('l1-6', 1, 'Idagdag ang 9 sa magkabilang panig.'),
  ('l1-6', 2, 'x = -3 + 9'),
  ('l1-7', 1, 'Alisin ang +7 sa magkabilang panig ng equation.'),
  ('l1-7', 2, 'x = 23 - 7'),
  ('l1-8', 1, 'Hatiin ang magkabilang panig ng 5.'),
  ('l1-8', 2, 'x = 45 ÷ 5'),
  ('l1-9', 1, 'I-multiply ang magkabilang panig ng 3.'),
  ('l1-9', 2, 'x = 8 × 3'),
  ('l1-10', 1, 'Idagdag muna ang 6: 4x = 18 + 6.'),
  ('l1-10', 2, '4x = 24, kaya x = 24 ÷ 4'),
  ('l2-1', 1, 'Ilipat ang 3x sa kaliwa: 5x - 3x = 12.'),
  ('l2-1', 2, '2x = 12, kaya x = 12 ÷ 2'),
  ('l2-2', 1, 'Ilipat ang 2x sa kaliwa at ang -4 sa kanan: 7x - 2x = 16 + 4.'),
  ('l2-2', 2, '5x = 20, kaya x = 20 ÷ 5'),
  ('l2-3', 1, 'Ilipat ang 2x sa kaliwa at ang 3 sa kanan: 6x - 2x = 19 - 3.'),
  ('l2-3', 2, '4x = 16, kaya x = 16 ÷ 4'),
  ('l2-4', 1, 'Ilipat ang 4x sa kaliwa at ang -5 sa kanan: 9x - 4x = 20 + 5.'),
  ('l2-4', 2, '5x = 25, kaya x = 25 ÷ 5'),
  ('l2-5', 1, 'Ilipat ang x sa kaliwa at ang 8 sa kanan: 3x - x = 20 - 8.'),
  ('l2-5', 2, '2x = 12, kaya x = 12 ÷ 2'),
  ('l2-6', 1, 'Ilipat ang 5x sa kaliwa: 8x - 5x = 21.'),
  ('l2-6', 2, '3x = 21, kaya x = 21 ÷ 3'),
  ('l2-7', 1, 'Ilipat ang 2x sa kaliwa at ang 9 sa kanan: 4x - 2x = 23 - 9.'),
  ('l2-7', 2, '2x = 14, kaya x = 14 ÷ 2'),
  ('l2-8', 1, 'Ilipat ang 6x sa kaliwa at ang -7 sa kanan: 10x - 6x = 13 + 7.'),
  ('l2-8', 2, '4x = 20, kaya x = 20 ÷ 4'),
  ('l2-9', 1, 'Ilipat ang 2x sa kaliwa at ang 6 sa kanan: 5x - 2x = 18 - 6.'),
  ('l2-9', 2, '3x = 12, kaya x = 12 ÷ 3'),
  ('l2-10', 1, 'Ilipat ang 3x sa kaliwa at ang -2 sa kanan: 7x - 3x = 14 + 2.'),
  ('l2-10', 2, '4x = 16, kaya x = 16 ÷ 4'),
  ('l3-1', 1, 'I-distribute muna: 4x + 8 = 3x + 15.'),
  ('l3-1', 2, 'Ilipat ang 3x at 8: 4x - 3x = 15 - 8'),
  ('l3-2', 1, 'I-distribute muna: 6x - 2 = 5x + 20.'),
  ('l3-2', 2, 'Ilipat ang 5x at -2: 6x - 5x = 20 + 2'),
  ('l3-3', 1, 'I-distribute muna: 3x + 12 = 2x + 18.'),
  ('l3-3', 2, 'Ilipat ang 2x at 12: 3x - 2x = 18 - 12'),
  ('l3-4', 1, 'I-distribute muna: 5x - 10 = 3x + 12.'),
  ('l3-4', 2, 'Ilipat ang 3x at -10: 5x - 3x = 12 + 10'),
  ('l3-5', 1, 'I-distribute muna: 2x + 10 = 3x + 3.'),
  ('l3-5', 2, 'Ilipat ang 2x at 3: 10 - 3 = 3x - 2x'),
  ('l3-6', 1, 'I-distribute muna: 6x - 6 = 4x + 12.'),
  ('l3-6', 2, 'Ilipat ang 4x at -6: 6x - 4x = 12 + 6'),
  ('l3-7', 1, 'I-distribute muna: 6x + 3 = 5x + 20.'),
  ('l3-7', 2, 'Ilipat ang 5x at 3: 6x - 5x = 20 - 3'),
  ('l3-8', 1, 'I-distribute muna: 4x + 20 = 2x + 22.'),
  ('l3-8', 2, 'Ilipat ang 2x at 20: 4x - 2x = 22 - 20'),
  ('l3-9', 1, 'I-distribute muna: 5x + 15 = 4x + 24.'),
  ('l3-9', 2, 'Ilipat ang 4x at 15: 5x - 4x = 24 - 15'),
  ('l3-10', 1, 'I-distribute muna: 8x - 6 = 6x + 6.'),
  ('l3-10', 2, 'Ilipat ang 6x at -6: 8x - 6x = 6 + 6')
on conflict (problem_id, hint_index) do update set hint_text = excluded.hint_text;
