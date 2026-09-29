-- ============================================================================
-- PIA 0034 -- RAW SCORES, HIGHEST POSSIBLE SCORES, AND THE TRANSMUTED SCORE
-- ============================================================================
-- The pre-test and post-test are now entered as two numbers -- the raw score
-- and the highest possible score -- and the score the study reports is the
-- transmuted score:
--
--     transmuted = (raw / highest possible) * 50 + 50       (range 50 - 100)
--
-- profiles gains, for each test, the two numbers the admin typed:
--
--     pre_test_raw_score    pre_test_max_score
--     post_test_raw_score   post_test_max_score
--
-- and pre_test_score / post_test_score keep their names and now hold the
-- transmuted score, rounded to 2 decimals. The raw data is what the thesis
-- rests on, so the database -- not the browser -- does the arithmetic: a
-- trigger calculates the transmuted score whenever the raw score or the
-- highest possible score changes, and refuses a score written without them.
-- The admin console shows the same calculation live, but only as a preview;
-- the stored value is always the database's.
--
-- Rules, enforced by the trigger (friendly messages) and CHECK constraints
-- (the backstop):
--   * raw and highest possible are given together, or both left blank;
--   * the highest possible score is more than 0;
--   * the raw score is between 0 and the highest possible score;
--   * clearing both clears the transmuted score;
--   * the transmuted score cannot be written directly.
--
-- EXISTING SCORES. A score entered before 0034 is a single number with no
-- record of what it was out of. It is NOT converted: splitting it into raw
-- and highest possible would mean guessing the denominator, and a guessed
-- value in the thesis data is worse than a missing one. Instead:
--   * every existing score is copied, unchanged, into profiles_score_backup_0034
--     (readable only here in the SQL editor), so nothing is ever lost;
--   * the score itself stays where it is, and the console shows it as
--     "entered as a single score" until the raw scores are entered for it;
--   * the postflight reports how many there are.
-- If you know every existing score was a raw score out of 100 items, this
-- converts them (the trigger then calculates the transmuted score):
--
--   update public.profiles set pre_test_raw_score = pre_test_score, pre_test_max_score = 100
--    where pre_test_raw_score is null and pre_test_score between 0 and 100;
--   update public.profiles set post_test_raw_score = post_test_score, post_test_max_score = 100
--    where post_test_raw_score is null and post_test_score between 0 and 100;
--
-- Only an administrator can write any of these columns: the profile write
-- guard (0001) is a whitelist, and none of them is on it. None of them is
-- exposed on the teacher surface.
--
-- SAFE TO RE-RUN. The postflight rehearses every rule as a real administrator
-- under RLS and rolls everything back.
--
-- Requires 0033.
-- ============================================================================

begin;

-- ---------------------------------------------------------------------------
-- PREFLIGHT
-- ---------------------------------------------------------------------------
do $$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'profiles' and column_name = 'parental_consent') then
    raise exception 'PIA 0034 ABORT (nothing changed): run 0033 first.' using errcode = 'P0001';
  end if;
  if (select count(*) from information_schema.columns
       where table_schema = 'public' and table_name = 'profiles'
         and column_name in ('pre_test_score', 'post_test_score')) <> 2 then
    raise exception 'PIA 0034 ABORT (nothing changed): profiles.pre_test_score / post_test_score are missing.'
      using errcode = 'P0001';
  end if;
end;
$$;


-- ---------------------------------------------------------------------------
-- 1. Keep every existing score, verbatim
-- ---------------------------------------------------------------------------
create table if not exists public.profiles_score_backup_0034 (
  email           text primary key,
  pre_test_score  numeric,
  post_test_score numeric,
  backed_up_at    timestamptz not null default now()
);

alter table public.profiles_score_backup_0034 enable row level security;
revoke all on public.profiles_score_backup_0034 from public, anon, authenticated;

comment on table public.profiles_score_backup_0034 is
  'Pre/post-test scores as they were before 0034 introduced raw scores. Owner-only; never written again.';

-- A re-run keeps the first copy: by then a score may already be transmuted.
insert into public.profiles_score_backup_0034 (email, pre_test_score, post_test_score)
select p.email, p.pre_test_score::numeric, p.post_test_score::numeric
  from public.profiles p
 where p.pre_test_score is not null or p.post_test_score is not null
on conflict (email) do nothing;


-- ---------------------------------------------------------------------------
-- 2. The raw columns, and room for a score with decimals
-- ---------------------------------------------------------------------------
alter table public.profiles
  add column if not exists pre_test_raw_score  numeric,
  add column if not exists pre_test_max_score  numeric,
  add column if not exists post_test_raw_score numeric,
  add column if not exists post_test_max_score numeric;

comment on column public.profiles.pre_test_raw_score  is 'Pre-test raw score as entered (0034).';
comment on column public.profiles.pre_test_max_score  is 'Pre-test highest possible score as entered (0034).';
comment on column public.profiles.post_test_raw_score is 'Post-test raw score as entered (0034).';
comment on column public.profiles.post_test_max_score is 'Post-test highest possible score as entered (0034).';
comment on column public.profiles.pre_test_score  is
  'Transmuted pre-test score = raw / max * 50 + 50, calculated by trg_compute_test_scores (0034). A value with no raw score was entered before 0034.';
comment on column public.profiles.post_test_score is
  'Transmuted post-test score = raw / max * 50 + 50, calculated by trg_compute_test_scores (0034). A value with no raw score was entered before 0034.';

-- A transmuted score like 66.67 must not be rounded to 67 by an integer column.
do $$
declare
  c      text;
  v_type text;
begin
  foreach c in array array['pre_test_score', 'post_test_score'] loop
    select format_type(a.atttypid, a.atttypmod) into v_type
      from pg_attribute a
     where a.attrelid = 'public.profiles'::regclass and a.attname = c and not a.attisdropped;

    if v_type ~ '^(integer|smallint|bigint|numeric\()' then
      begin
        execute format('alter table public.profiles alter column %I type numeric using %I::numeric', c, c);
        raise notice 'PIA 0034: % changed from % to numeric.', c, v_type;
      exception when others then
        raise exception 'PIA 0034 ABORT (nothing changed): could not change % from % to numeric (%).', c, v_type, sqlerrm
          using errcode = 'P0001';
      end;
    end if;
  end loop;
end;
$$;

alter table public.profiles drop constraint if exists profiles_pre_test_raw_valid;
alter table public.profiles add constraint profiles_pre_test_raw_valid check (
  (pre_test_raw_score is null) = (pre_test_max_score is null)
  and (pre_test_max_score is null
       or (pre_test_max_score > 0 and pre_test_raw_score >= 0 and pre_test_raw_score <= pre_test_max_score)));

alter table public.profiles drop constraint if exists profiles_post_test_raw_valid;
alter table public.profiles add constraint profiles_post_test_raw_valid check (
  (post_test_raw_score is null) = (post_test_max_score is null)
  and (post_test_max_score is null
       or (post_test_max_score > 0 and post_test_raw_score >= 0 and post_test_raw_score <= post_test_max_score)));


-- ---------------------------------------------------------------------------
-- 3. The calculation
-- ---------------------------------------------------------------------------
create or replace function public.pia_transmute(p_raw numeric, p_max numeric)
returns numeric
language sql
immutable
set search_path = public
as $$
  select round(p_raw / p_max * 50 + 50, 2);
$$;

-- One test's three columns, checked and settled. Returns the score to store.
create or replace function public.pia_settle_test_score(
  p_label     text,
  p_insert    boolean,
  p_raw       numeric, p_max     numeric, p_score     numeric,
  p_old_raw   numeric, p_old_max numeric, p_old_score numeric)
returns numeric
language plpgsql
set search_path = public
as $$
begin
  -- No raw data.
  if p_raw is null and p_max is null then
    -- The raw data was just cleared: the score it produced goes with it.
    if not p_insert and (p_old_raw is not null or p_old_max is not null)
       and p_score is not distinct from p_old_score then
      return null;
    end if;
    -- A new score typed on its own (an old console, or a direct write).
    if p_score is not null and (p_insert or p_score is distinct from p_old_score) then
      raise exception 'PIA: the % score is calculated from the raw score and the highest possible score -- enter both. (If the console asks for a single score, reload it.)', p_label
        using errcode = '22023';
    end if;
    -- Blank, or a score entered before 0034, kept as it was.
    return p_score;
  end if;

  if p_raw is null or p_max is null then
    raise exception 'PIA: enter both the raw score and the highest possible score for the %.', p_label
      using errcode = '22023';
  end if;
  if p_max <= 0 then
    raise exception 'PIA: the highest possible score for the % must be more than 0.', p_label
      using errcode = '22023';
  end if;
  if p_raw < 0 or p_raw > p_max then
    raise exception 'PIA: the % raw score must be between 0 and the highest possible score (%).', p_label, p_max
      using errcode = '22023';
  end if;

  -- New raw data: calculate.
  if p_insert or p_raw is distinct from p_old_raw or p_max is distinct from p_old_max then
    return public.pia_transmute(p_raw, p_max);
  end if;

  -- Raw data unchanged. The stored score is left exactly as it is -- a
  -- student's own heartbeat update must not rewrite it -- and cannot be
  -- overwritten by hand.
  if p_score is distinct from p_old_score then
    raise exception 'PIA: the % score is calculated from the raw score -- change the raw score instead.', p_label
      using errcode = '22023';
  end if;
  return p_old_score;
end;
$$;

create or replace function public.pia_compute_test_scores()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_insert boolean := tg_op = 'INSERT';
begin
  new.pre_test_score := public.pia_settle_test_score('pre-test', v_insert,
    new.pre_test_raw_score, new.pre_test_max_score, new.pre_test_score,
    case when v_insert then null else old.pre_test_raw_score end,
    case when v_insert then null else old.pre_test_max_score end,
    case when v_insert then null else old.pre_test_score end);

  new.post_test_score := public.pia_settle_test_score('post-test', v_insert,
    new.post_test_raw_score, new.post_test_max_score, new.post_test_score,
    case when v_insert then null else old.post_test_raw_score end,
    case when v_insert then null else old.post_test_max_score end,
    case when v_insert then null else old.post_test_score end);

  return new;
end;
$$;

-- pia_transmute and pia_settle_test_score keep their default EXECUTE: they
-- read no data, and the trigger runs them as whoever is writing the row (an
-- admin, a student's heartbeat, the service role).
revoke all on function public.pia_compute_test_scores() from public, anon, authenticated;

-- BEFORE triggers run in name order: after trg_admin_boundaries (0031), and
-- before trg_enforce_profile_write_scope (0001) compares old and new.
drop trigger if exists trg_compute_test_scores on public.profiles;
create trigger trg_compute_test_scores
  before insert or update on public.profiles
  for each row execute function public.pia_compute_test_scores();


-- ---------------------------------------------------------------------------
-- POSTFLIGHT -- rolled back.
-- ---------------------------------------------------------------------------
do $$
declare
  v_admin   text;
  v_student text;
  v_iat     bigint := extract(epoch from clock_timestamp())::bigint + 5;
  v_pre     numeric;
  v_post    numeric;
  v_legacy_pre  int;
  v_legacy_post int;
  v_fail    text := '';
begin
  select count(*) filter (where pre_test_score is not null and pre_test_raw_score is null),
         count(*) filter (where post_test_score is not null and post_test_raw_score is null)
    into v_legacy_pre, v_legacy_post
    from public.profiles;

  select email into v_admin from public.profiles where lower(trim(role)) = 'admin' order by email limit 1;
  select email into v_student from public.profiles
   where lower(trim(coalesce(role, 'student'))) = 'student' order by email limit 1;

  if v_admin is null or v_student is null then
    raise notice 'PIA 0034: no administrator or no student to rehearse with -- skipped.';
  else
    begin
      perform set_config('request.jwt.claims', json_build_object(
        'email', v_admin, 'role', 'authenticated', 'iat', v_iat)::text, true);
      execute 'set local role authenticated';

      -- A. Raw and highest possible in, transmuted score out.
      update public.profiles
         set pre_test_raw_score = 40, pre_test_max_score = 50,
             post_test_raw_score = 1, post_test_max_score = 3
       where email = v_student;
      select pre_test_score, post_test_score into v_pre, v_post from public.profiles where email = v_student;
      if v_pre is distinct from 90.00 then
        v_fail := v_fail || format('40/50 gave %s, expected 90; ', v_pre);
      end if;
      if v_post is distinct from 66.67 then
        v_fail := v_fail || format('1/3 gave %s, expected 66.67; ', v_post);
      end if;

      -- B. Refusals.
      begin
        update public.profiles set pre_test_raw_score = 60 where email = v_student;   -- 60 of 50
        v_fail := v_fail || 'a raw score above the highest possible score was accepted; ';
      exception when sqlstate '22023' or sqlstate '23514' then null;
      end;
      begin
        update public.profiles set pre_test_max_score = null where email = v_student;  -- raw without max
        v_fail := v_fail || 'a raw score without its highest possible score was accepted; ';
      exception when sqlstate '22023' or sqlstate '23514' then null;
      end;
      begin
        update public.profiles set pre_test_raw_score = 0, pre_test_max_score = 0 where email = v_student;
        v_fail := v_fail || 'a highest possible score of 0 was accepted; ';
      exception when sqlstate '22023' or sqlstate '23514' then null;
      end;
      begin
        update public.profiles set pre_test_score = 99 where email = v_student;        -- by hand
        v_fail := v_fail || 'a transmuted score was overwritten by hand; ';
      exception when sqlstate '22023' then null;
      end;

      -- C. An unrelated change leaves the score alone.
      update public.profiles set full_name = full_name where email = v_student;
      select pre_test_score into v_pre from public.profiles where email = v_student;
      if v_pre is distinct from 90.00 then
        v_fail := v_fail || 'an unrelated update changed the transmuted score; ';
      end if;

      -- D. Clearing the raw data clears the score.
      update public.profiles set post_test_raw_score = null, post_test_max_score = null where email = v_student;
      select post_test_score into v_post from public.profiles where email = v_student;
      if v_post is not null then
        v_fail := v_fail || 'clearing the raw score left a transmuted score behind; ';
      end if;

      -- E. A single score with no raw data is refused.
      begin
        update public.profiles set post_test_score = 77 where email = v_student;
        v_fail := v_fail || 'a single score without raw data was accepted; ';
      exception when sqlstate '22023' then null;
      end;

      execute 'reset role';

      -- F. The student cannot write their own raw score.
      perform set_config('request.jwt.claims', json_build_object(
        'email', v_student, 'role', 'authenticated', 'iat', v_iat)::text, true);
      execute 'set local role authenticated';
      begin
        update public.profiles set pre_test_raw_score = 50 where email = v_student;
      exception when sqlstate '42501' then null;
      end;
      execute 'reset role';
      perform set_config('request.jwt.claims', '', true);

      select pre_test_score into v_pre from public.profiles where email = v_student;
      if v_pre is distinct from 90.00 then
        v_fail := v_fail || 'a student changed their own raw score; ';
      end if;

      if v_fail <> '' then
        raise exception 'PIA 0034 ABORT: %', v_fail using errcode = 'P0001';
      end if;
      raise exception 'rehearsal done' using errcode = 'P0002';
    exception
      when sqlstate 'P0002' then
        raise notice 'PIA 0034 OK: raw and highest possible scores are stored; the transmuted score is calculated by the database and cannot be written by hand.';
    end;

    perform set_config('request.jwt.claims', '', true);
  end if;

  raise notice 'PIA 0034: % pre-test and % post-test score(s) were entered as a single number before 0034. They are kept as they were (and copied to profiles_score_backup_0034) until raw scores are entered for them.',
    v_legacy_pre, v_legacy_post;
end;
$$;

commit;

notify pgrst, 'reload schema';
