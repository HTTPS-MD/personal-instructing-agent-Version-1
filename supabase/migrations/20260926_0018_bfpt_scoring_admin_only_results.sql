-- ============================================================================
-- PIA 0018 -- BFPT SCORING, AND ASSESSMENT RESULTS FOR ADMINS ONLY
-- ============================================================================
-- Source of truth: 20260722_Table BFPT.pdf -- "The Big Five Personality Test
-- (BFPT)", openpsychometrics.org printable, 50 items on a 1-5 scale, five
-- traits each scored 0-40 by the math strings on its scoring sheet (pp. 5-6).
--
-- WHAT CHANGES
--
--   1. SCORING FOLLOWS THE SHEET EXACTLY. The key now lives in ONE function,
--      public.pia_bfpt_score(), transcribed term for term from the sheet.
--      E, A, C and O are unchanged from 0002. N IS NOT: 0002 computed the
--      sheet's N string and then stored 40 minus it. The sheet has no such
--      step, so this migration drops it. Every stored submission is re-scored
--      from its saved answers, so old and new results share one key.
--
--      Read the N note before interpreting results. The sheet's N string
--      SUBTRACTS the eight stress items ("Get stressed out easily", "Worry
--      about things", ...) and ADDS "Am relaxed most of the time" and "Seldom
--      feel blue". Scored as written, a HIGHER N means CALMER answers -- the
--      reverse of the sheet's own prose definition of Neuroticism. The admin
--      drawer says so beside the score. To score N the other way, change the
--      N line of pia_bfpt_score() to `40 - (38 - ...)` and re-run PART 2;
--      the raw answers are kept, so nothing is lost either way.
--
--   2. RESULTS ARE READABLE BY ADMINS AND NOBODY ELSE. Until now the five
--      scores were also copied onto profiles -- a row every student can read
--      about themselves, and every teacher can read for their section. So a
--      student could see their own scores from the browser console, and the
--      login screen's select('*') already downloaded them. From here:
--        * scores exist ONLY in public.ocean_submissions, whose single RLS
--          policy admits an admin with a current session;
--        * profiles.ocean_e/a/c/n/o are cleared, and a CHECK constraint
--          stops any code path ever writing a score there again;
--        * submit_ocean_results() returns { next_stage } and nothing else,
--          so the student's own network tab shows no score either.
--      profiles.is_ocean_done stays: it is a completion flag, not a result,
--      and the stage chain depends on it.
--
--   3. NOTHING IS LOST. Retakes append a row instead of erasing one (the
--      admin drawer shows the latest), and any scores that existed only on
--      profiles -- from before 0002 kept raw answers -- are copied into
--      ocean_submissions before profiles is cleared.
--
-- WHAT THIS DOES NOT TOUCH
--   auth.*, the login path, the stage chain, sections, tutoring tables.
--
-- RUN IT ALL AT ONCE. One transaction: PART 6 proves the result against the
-- sheet's worked example, the access rules and an end-to-end submission, and
-- if any check fails NOTHING changes. Rollback notes are at the bottom.
-- ============================================================================

begin;

-- ===========================================================================
-- PART 1 -- THE SCORING KEY
-- One function, so the questionnaire, the re-score below and the self-test
-- all run exactly the same arithmetic. Each line is the sheet's math string
-- with (n) replaced by r[n], the answer to item n.
-- ===========================================================================
create or replace function public.pia_bfpt_score(r integer[])
returns table (ocean_e integer, ocean_a integer, ocean_c integer, ocean_n integer, ocean_o integer)
language sql
immutable
strict
set search_path = public
as $$
  select
    -- E = 20 + (1) - (6) + (11) - (16) + (21) - (26) + (31) - (36) + (41) - (46)
    20 + r[1]  - r[6]  + r[11] - r[16] + r[21] - r[26] + r[31] - r[36] + r[41] - r[46],
    -- A = 14 - (2) + (7) - (12) + (17) - (22) + (27) - (32) + (37) + (42) + (47)
    14 - r[2]  + r[7]  - r[12] + r[17] - r[22] + r[27] - r[32] + r[37] + r[42] + r[47],
    -- C = 14 + (3) - (8) + (13) - (18) + (23) - (28) + (33) - (38) + (43) + (48)
    14 + r[3]  - r[8]  + r[13] - r[18] + r[23] - r[28] + r[33] - r[38] + r[43] + r[48],
    -- N = 38 - (4) + (9) - (14) + (19) - (24) - (29) - (34) - (39) - (44) - (49)
    38 - r[4]  + r[9]  - r[14] + r[19] - r[24] - r[29] - r[34] - r[39] - r[44] - r[49],
    -- O = 8 + (5) - (10) + (15) - (20) + (25) - (30) + (35) + (40) + (45) + (50)
     8 + r[5]  - r[10] + r[15] - r[20] + r[25] - r[30] + r[35] + r[40] + r[45] + r[50]
$$;

-- Server-side only. The SECURITY DEFINER submit function calls it with the
-- owner's rights; no client role needs to.
revoke all on function public.pia_bfpt_score(integer[]) from public, anon, authenticated;


-- ===========================================================================
-- PART 2 -- ocean_submissions: provenance, and one key for every row
-- ===========================================================================
alter table public.ocean_submissions
  add column if not exists scoring_key text,
  add column if not exists source      text;

-- A row copied from profiles (PART 3) has scores but no raw answers, because
-- none were kept before 0002. Every other row must still carry all 50.
alter table public.ocean_submissions alter column responses drop not null;
alter table public.ocean_submissions drop constraint if exists ocean_submissions_50_items;
alter table public.ocean_submissions add constraint ocean_submissions_50_items
  check (responses is null or array_length(responses, 1) = 50);

do $$
declare
  v_rows int;
  v_n_changed int;
begin
  select count(*) into v_n_changed
    from public.ocean_submissions s
    cross join lateral public.pia_bfpt_score(s.responses::integer[]) k
   where s.responses is not null and s.ocean_n is distinct from k.ocean_n;

  update public.ocean_submissions s
     set (ocean_e, ocean_a, ocean_c, ocean_n, ocean_o) =
         (select k.ocean_e, k.ocean_a, k.ocean_c, k.ocean_n, k.ocean_o
            from public.pia_bfpt_score(s.responses::integer[]) k),
         scoring_key = 'bfpt-2026-07-22',
         source      = coalesce(s.source, 'questionnaire')
   where s.responses is not null;
  get diagnostics v_rows = row_count;

  raise notice 'PIA 0018: re-scored % submission(s) with the BFPT sheet; N changed on %.', v_rows, v_n_changed;
end;
$$;


-- ===========================================================================
-- PART 3 -- move every score off profiles
-- ===========================================================================
do $$
declare
  v_copied int;
  v_partial int;
  v_cleared int;
begin
  -- Scores that exist ONLY on profiles: full sets with no submission row.
  -- Written by the pre-0002 browser, which used the same key as 0002 --
  -- including its 40-minus step on N -- so the sheet's N is 40 minus the
  -- stored value, and E/A/C/O copy across unchanged.
  insert into public.ocean_submissions
         (email, responses, ocean_e, ocean_a, ocean_c, ocean_n, ocean_o, scoring_key, source)
  select p.email, null, p.ocean_e, p.ocean_a, p.ocean_c, 40 - p.ocean_n, p.ocean_o,
         'bfpt-2026-07-22', 'legacy-profile'
    from public.profiles p
   where p.ocean_e is not null and p.ocean_a is not null and p.ocean_c is not null
     and p.ocean_n is not null and p.ocean_o is not null
     and not exists (select 1 from public.ocean_submissions s where lower(s.email) = lower(p.email));
  get diagnostics v_copied = row_count;

  -- An incomplete set cannot be a result; it is reported, then cleared.
  select count(*) into v_partial
    from public.profiles p
   where num_nonnulls(p.ocean_e, p.ocean_a, p.ocean_c, p.ocean_n, p.ocean_o) between 1 and 4;

  -- Runs as the migration owner, so the profile write guard (0001) lets it
  -- through: that guard only polices writes arriving as `authenticated`.
  update public.profiles
     set ocean_e = null, ocean_a = null, ocean_c = null, ocean_n = null, ocean_o = null
   where num_nonnulls(ocean_e, ocean_a, ocean_c, ocean_n, ocean_o) > 0;
  get diagnostics v_cleared = row_count;

  raise notice 'PIA 0018: copied % legacy result(s) into ocean_submissions; cleared scores from % profile(s); % incomplete set(s) discarded.',
    v_copied, v_cleared, v_partial;
end;
$$;

-- Every row now has a key and a source; make that permanent.
alter table public.ocean_submissions alter column scoring_key set not null;
alter table public.ocean_submissions alter column source      set not null;
alter table public.ocean_submissions drop constraint if exists ocean_submissions_answers_or_legacy;
alter table public.ocean_submissions add constraint ocean_submissions_answers_or_legacy
  check (responses is not null or source = 'legacy-profile');

-- The columns stay so that old scripts selecting them keep working -- but no
-- code path can ever put a score back where students and teachers can read it.
alter table public.profiles drop constraint if exists profiles_ocean_scores_admin_only;
alter table public.profiles add constraint profiles_ocean_scores_admin_only
  check (ocean_e is null and ocean_a is null and ocean_c is null and ocean_n is null and ocean_o is null);


-- ===========================================================================
-- PART 4 -- who may read the results: admins, with a current session
-- ===========================================================================
alter table public.ocean_submissions enable row level security;

-- Exactly one policy may exist. Anything else on this table -- a console-made
-- "own read", say -- would be OR-ed with it and reopen the results.
do $$
declare
  p record;
begin
  for p in
    select policyname from pg_policies
     where schemaname = 'public' and tablename = 'ocean_submissions'
       and policyname <> 'ocean_submissions_admin_read'
  loop
    execute format('drop policy %I on public.ocean_submissions', p.policyname);
    raise notice 'PIA 0018: dropped extra policy % on ocean_submissions.', p.policyname;
  end loop;
end;
$$;

drop policy if exists ocean_submissions_admin_read on public.ocean_submissions;
create policy ocean_submissions_admin_read on public.ocean_submissions
  for select to authenticated
  using (public.pia_caller_role() = 'admin' and public.jwt_is_current());

-- Reads only; every write goes through submit_ocean_results().
revoke all on public.ocean_submissions from anon, authenticated;
grant select on public.ocean_submissions to authenticated;

-- A view over this table that runs with its OWNER's rights would bypass the
-- policy above for anyone granted the view. Make every such view check the
-- caller instead, so the policy applies through it.
do $$
declare
  v record;
begin
  for v in
    select distinct c.oid::regclass as view_name
      from pg_depend d
      join pg_rewrite w on w.oid = d.objid
      join pg_class   c on c.oid = w.ev_class
     where d.classid  = 'pg_rewrite'::regclass
       and d.refobjid = 'public.ocean_submissions'::regclass
       and c.relkind = 'v'
       and not coalesce('security_invoker=true' = any(c.reloptions)
                     or 'security_invoker=on'   = any(c.reloptions), false)
  loop
    execute format('alter view %s set (security_invoker = true)', v.view_name);
    raise notice 'PIA 0018: view % now checks the caller''s rights.', v.view_name;
  end loop;
end;
$$;


-- ===========================================================================
-- PART 5 -- submit_ocean_results(p_responses)
--   p_responses: the 50 answers (1..5), in the order of window.PIA_BFPT.items
--                (assets/js/bfpt-items.js).
--   Returns { next_stage } ONLY. No score, trait or persona leaves the server.
--
-- Messages are neutral on purpose: the questionnaire page shows a failure
-- message to the student verbatim, so none of them names the instrument.
-- ===========================================================================
create or replace function public.submit_ocean_results(p_responses integer[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_profile public.profiles%rowtype;
  r         integer[];
  k         record;
  v_needs_character boolean;
  v_next_stage text;
begin
  if v_email is null then
    raise exception 'PIA: no authenticated session.' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles where email = v_email;
  if not found then
    raise exception 'PIA: no profile found for this session.' using errcode = '42501';
  end if;

  -- Once only. The admin retake action sets is_ocean_done back to false.
  if coalesce(v_profile.is_ocean_done, false) then
    raise exception 'PIA: this questionnaire has already been submitted. Ask an admin for a retake.'
      using errcode = '42501';
  end if;

  if p_responses is null or array_length(p_responses, 1) is distinct from 50 then
    raise exception 'PIA: exactly 50 responses are required (received: %).',
      coalesce(array_length(p_responses, 1), 0) using errcode = '22023';
  end if;

  -- Re-based to 1..50 in order, so r[n] is item n even if a caller crafts an
  -- array with a different lower bound.
  r := array(select x from unnest(p_responses) with ordinality as t(x, i) order by i);

  if exists (select 1 from unnest(r) v where v is null or v < 1 or v > 5) then
    raise exception 'PIA: every response must be between 1 and 5.' using errcode = '22023';
  end if;

  select * into k from public.pia_bfpt_score(r);

  -- Next stage -- decided here, never in the browser. Unchanged from 0002.
  v_needs_character :=
    lower(trim(coalesce(v_profile.group_type, ''))) in ('non-assigned', 'non_assigned')
    and v_profile.selected_character is null;

  if v_needs_character then
    v_next_stage := case when public.pia_stage_open('stage_char')
                         then 'Character Selection' else 'Waiting Room' end;
  else
    v_next_stage := case when public.pia_stage_open('stage_dash')
                         then 'Tutoring Dashboard' else 'Waiting Room' end;
  end if;

  insert into public.ocean_submissions
         (email, responses, ocean_e, ocean_a, ocean_c, ocean_n, ocean_o, scoring_key, source)
  values (v_email, r::smallint[], k.ocean_e, k.ocean_a, k.ocean_c, k.ocean_n, k.ocean_o,
          'bfpt-2026-07-22', 'questionnaire');

  -- The completion flag and the stage. Deliberately no score.
  update public.profiles set
    is_ocean_done    = true,
    current_stage    = v_next_stage,
    stage_started_at = now()
  where email = v_email;

  return jsonb_build_object('next_stage', v_next_stage);
end;
$$;

revoke all on function public.submit_ocean_results(integer[]) from public, anon;
grant execute on function public.submit_ocean_results(integer[]) to authenticated;


-- ===========================================================================
-- PART 6 -- SELF-VERIFICATION. Runs before COMMIT. Any failure raises, and
-- the whole migration rolls back: a mistake here cannot reach live data.
-- ===========================================================================
do $$
declare
  -- The sheet's worked example ("BFPT Completed Example"): all 50 answers,
  -- read off its five math strings, which between them use every item once.
  v_example constant integer[] := array[
    1,1,5,4,5,  4,4,1,2,1,  3,1,5,5,2,  5,5,1,4,2,  4,3,4,2,4,
    3,5,2,4,3,  2,3,5,3,5,  5,3,1,2,4,  1,5,5,3,5,  4,4,5,2,5];
  -- The items the sheet SUBTRACTS. Answering each of these 5 and every other
  -- item 1 must drive all five traits to 0; the mirror image, to 40.
  v_minus constant integer[] := array[
    6,16,26,36,46,  2,12,22,32,  8,18,28,38,  4,14,24,29,34,39,44,49,  10,20,30];
  v_floor   integer[];
  v_ceil    integer[];
  k         record;
  v_row     record;
  v_result  jsonb;
  v_keys    text[];
  n         int;
  v_total   int;
  v_admin   text;
  v_student text;
  v_teacher text;
  v_reader  text;
begin
  -- (1) The sheet's own worked example: E 10, A 32, C 38, N 19, O 32.
  select * into k from public.pia_bfpt_score(v_example);
  if (k.ocean_e, k.ocean_a, k.ocean_c, k.ocean_n, k.ocean_o) is distinct from (10, 32, 38, 19, 32) then
    raise exception 'PIA ABORT: the worked example scored E% A% C% N% O%; the sheet says E10 A32 C38 N19 O32.',
      k.ocean_e, k.ocean_a, k.ocean_c, k.ocean_n, k.ocean_o using errcode = 'P0001';
  end if;

  -- (2) "Each personality trait will have a score between zero and forty."
  v_floor := array(select case when g.i = any(v_minus) then 5 else 1 end
                     from generate_series(1, 50) as g(i) order by g.i);
  v_ceil  := array(select case when g.i = any(v_minus) then 1 else 5 end
                     from generate_series(1, 50) as g(i) order by g.i);

  select * into k from public.pia_bfpt_score(v_floor);
  if (k.ocean_e, k.ocean_a, k.ocean_c, k.ocean_n, k.ocean_o) is distinct from (0, 0, 0, 0, 0) then
    raise exception 'PIA ABORT: the lowest possible answers scored E% A% C% N% O%, expected all 0.',
      k.ocean_e, k.ocean_a, k.ocean_c, k.ocean_n, k.ocean_o using errcode = 'P0001';
  end if;

  select * into k from public.pia_bfpt_score(v_ceil);
  if (k.ocean_e, k.ocean_a, k.ocean_c, k.ocean_n, k.ocean_o) is distinct from (40, 40, 40, 40, 40) then
    raise exception 'PIA ABORT: the highest possible answers scored E% A% C% N% O%, expected all 40.',
      k.ocean_e, k.ocean_a, k.ocean_c, k.ocean_n, k.ocean_o using errcode = 'P0001';
  end if;

  -- (3) Every stored answer set carries the sheet's scores, and one key.
  select count(*) into n
    from public.ocean_submissions s
    cross join lateral public.pia_bfpt_score(s.responses::integer[]) k2
   where s.responses is not null
     and (s.ocean_e, s.ocean_a, s.ocean_c, s.ocean_n, s.ocean_o)
         is distinct from (k2.ocean_e, k2.ocean_a, k2.ocean_c, k2.ocean_n, k2.ocean_o);
  if n <> 0 then
    raise exception 'PIA ABORT: % submission(s) do not match the BFPT key after re-scoring.', n
      using errcode = 'P0001';
  end if;

  select count(*) into n from public.ocean_submissions where scoring_key <> 'bfpt-2026-07-22';
  if n <> 0 then
    raise exception 'PIA ABORT: % submission(s) carry a scoring key other than bfpt-2026-07-22.', n
      using errcode = 'P0001';
  end if;

  -- (4) No score left anywhere a student or teacher can read.
  select count(*) into n from public.profiles
   where num_nonnulls(ocean_e, ocean_a, ocean_c, ocean_n, ocean_o) > 0;
  if n <> 0 then
    raise exception 'PIA ABORT: % profile(s) still carry a score.', n using errcode = 'P0001';
  end if;

  -- (5) Access, as each kind of user actually sees it.
  select count(*) into v_total from public.ocean_submissions;
  select email into v_admin   from public.profiles where lower(trim(role)) = 'admin'   order by email limit 1;
  select email into v_teacher from public.profiles where lower(trim(role)) = 'teacher' order by email limit 1;
  select email into v_student from public.profiles
   where lower(trim(coalesce(role, 'student'))) = 'student' order by email limit 1;

  if v_admin is not null then
    perform set_config('request.jwt.claims',
      json_build_object('email', v_admin, 'role', 'authenticated',
                        'iat', extract(epoch from now())::bigint)::text, true);
    execute 'set local role authenticated';
    select count(*) into n from public.ocean_submissions;
    execute 'reset role';
    if n <> v_total then
      raise exception 'PIA ABORT: the admin (%) sees % of % results -- the dashboard would be blind.',
        v_admin, n, v_total using errcode = 'P0001';
    end if;
  end if;

  foreach v_reader in array array_remove(array[v_student, v_teacher], null) loop
    perform set_config('request.jwt.claims',
      json_build_object('email', v_reader, 'role', 'authenticated',
                        'iat', extract(epoch from now())::bigint)::text, true);
    execute 'set local role authenticated';
    select count(*) into n from public.ocean_submissions;
    execute 'reset role';
    if n <> 0 then
      raise exception 'PIA ABORT: % (not an admin) can read % result row(s).', v_reader, n
        using errcode = 'P0001';
    end if;
  end loop;

  -- (6) End to end, as a real student submission -- inside a subtransaction
  -- that is ALWAYS rolled back, so the test leaves no trace. Only the
  -- sentinel code PX999 is caught; a failed check propagates and aborts.
  if v_student is not null then
    begin
      update public.profiles set is_ocean_done = false where email = v_student;

      perform set_config('request.jwt.claims',
        json_build_object('email', v_student, 'role', 'authenticated',
                          'iat', extract(epoch from now())::bigint)::text, true);
      v_result := public.submit_ocean_results(v_example);

      select array_agg(t.key order by t.key) into v_keys from jsonb_object_keys(v_result) as t(key);
      if v_keys is distinct from array['next_stage'] then
        raise exception 'PIA ABORT: submit_ocean_results returned %; it may return next_stage only.', v_result
          using errcode = 'P0001';
      end if;

      select * into v_row from public.ocean_submissions
       where email = v_student order by submitted_at desc, id desc limit 1;
      if (v_row.ocean_e, v_row.ocean_a, v_row.ocean_c, v_row.ocean_n, v_row.ocean_o)
           is distinct from (10, 32, 38, 19, 32)
         or v_row.scoring_key is distinct from 'bfpt-2026-07-22'
         or array_length(v_row.responses, 1) is distinct from 50 then
        raise exception 'PIA ABORT: an end-to-end submission stored E% A% C% N% O% (key %).',
          v_row.ocean_e, v_row.ocean_a, v_row.ocean_c, v_row.ocean_n, v_row.ocean_o, v_row.scoring_key
          using errcode = 'P0001';
      end if;

      if exists (select 1 from public.profiles
                  where email = v_student
                    and (num_nonnulls(ocean_e, ocean_a, ocean_c, ocean_n, ocean_o) > 0
                         or is_ocean_done is not true)) then
        raise exception 'PIA ABORT: the submission left a score on profiles, or did not mark it done.'
          using errcode = 'P0001';
      end if;

      raise exception 'self-test complete' using errcode = 'PX999';
    exception
      when sqlstate 'PX999' then null;   -- the test's own writes are undone here
    end;
  end if;

  perform set_config('request.jwt.claims', '', true);

  raise notice 'PIA 0018 OK: worked example E10 A32 C38 N19 O32; range 0-40; % result row(s) re-verified; admin reads all, students and teachers read none; submission returns next_stage only.',
    v_total;
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Final report -- what the SQL editor shows after a successful run.
select 'ocean_submissions' as object, count(*)::text as detail from public.ocean_submissions
union all
select 'results with raw answers', count(*)::text from public.ocean_submissions where responses is not null
union all
select 'legacy results (no answers kept)', count(*)::text from public.ocean_submissions where source = 'legacy-profile'
union all
select 'profiles still holding a score', count(*)::text from public.profiles
 where num_nonnulls(ocean_e, ocean_a, ocean_c, ocean_n, ocean_o) > 0
union all
select 'policy: ' || policyname, coalesce(qual, '') from pg_policies
 where schemaname = 'public' and tablename = 'ocean_submissions';


-- ============================================================================
-- ROLLBACK NOTES
-- ----------------------------------------------------------------------------
-- The re-score is reversible from the raw answers at any time: edit the N line
-- of pia_bfpt_score() and re-run PART 2. To restore 0002's N convention, that
-- line becomes:
--     40 - (38 - r[4] + r[9] - r[14] + r[19] - r[24] - r[29] - r[34] - r[39] - r[44] - r[49]),
--
-- To put scores back on profiles (NOT recommended -- it reopens them to the
-- student themselves and to their teacher):
--   alter table public.profiles drop constraint profiles_ocean_scores_admin_only;
--   update public.profiles p set (ocean_e, ocean_a, ocean_c, ocean_n, ocean_o) =
--     (select s.ocean_e, s.ocean_a, s.ocean_c, s.ocean_n, s.ocean_o
--        from public.ocean_submissions s where lower(s.email) = lower(p.email)
--       order by s.submitted_at desc, s.id desc limit 1);
-- and restore submit_ocean_results() from 0002.
-- ============================================================================
