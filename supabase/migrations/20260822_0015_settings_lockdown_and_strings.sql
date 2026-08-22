-- ============================================================================
-- PIA 0015 -- (A) REMOVE global_password + LOCK settings  (B) LAST 3 STRINGS
-- ============================================================================

begin;

-- ===========================================================================
-- PART A1 -- delete the credential
--
-- `settings` is readable by every signed-in student, because isStageOpen()
-- needs the stage_* flags. `global_password` sat in that same table, so any
-- student could read it with one console call:
--     await supabaseClient.from('settings').select('*')
--
-- A comment in admin-dashboard.js states this key was already removed as a
-- security fix. It was not. Nothing in the codebase could contradict that
-- claim, because the database layer was never versioned -- which is exactly
-- the failure mode these migrations exist to end.
--
-- No code reads this key any more (verified by grep across all JS and HTML);
-- accounts are provisioned with generateSecurePassword() per student.
-- ===========================================================================
delete from public.settings where key = 'global_password';


-- ===========================================================================
-- PART A2 -- stop it happening again
--
-- Deleting the row fixes today. A RESTRICTIVE policy fixes tomorrow: whatever
-- key anyone adds to `settings` later, students can only ever read stage_*.
--
-- RESTRICTIVE policies are ANDed with the permissive ones, so this ADDS a
-- constraint without touching the 3 existing policies:
--     final access = (any permissive policy) AND (every restrictive policy)
--
-- Admins keep full read. pia_stage_open() only ever reads stage_* keys, so it
-- is unaffected either way.
-- ===========================================================================
drop policy if exists settings_non_admin_stage_only on public.settings;

create policy settings_non_admin_stage_only on public.settings
  as restrictive
  for select
  to authenticated
  using (key like 'stage\_%' or public.pia_caller_role() = 'admin');


-- ===========================================================================
-- PART B -- the last three user-facing strings
-- ===========================================================================
do $$
declare
  r     record;
  v_def text;
  v_new text;
  i     int;
  n     int := 0;
  v_map text[][] := array[
    array['Group is not non-assigned -- walang character selection para sa kanila.',
          'Group is not non-assigned -- character selection does not apply to them.'],
    array['Non-assigned pero wala pang napiling character.',
          'Non-assigned but no character has been selected yet.'],
    array['Masyadong maraming session. Sandali lang po.',
          'Too many sessions started. Please wait a moment.']
  ];
begin
  for r in
    select p.oid, p.proname
      from pg_proc p join pg_namespace nsp on nsp.oid = p.pronamespace
     where nsp.nspname = 'public' and p.prokind = 'f'
  loop
    v_def := pg_get_functiondef(r.oid);
    v_new := v_def;
    for i in 1 .. array_length(v_map, 1) loop
      v_new := replace(v_new, v_map[i][1], v_map[i][2]);
    end loop;
    if v_new is distinct from v_def then
      execute v_new;
      n := n + 1;
      raise notice 'PIA: translated %', r.proname;
    end if;
  end loop;
  raise notice 'PIA: % function(s) updated.', n;
end;
$$;


-- ===========================================================================
-- SELF-VERIFICATION -- runs BEFORE commit. If anything is wrong this raises
-- and the whole migration rolls back, so it cannot lock you out.
-- ===========================================================================
do $$
declare
  v_student text;
  v_admin   text;
  n_student int;
  n_admin   int;
begin
  select email into v_student from public.profiles
   where lower(trim(coalesce(role,'student'))) = 'student' order by email limit 1;
  select email into v_admin from public.profiles
   where lower(trim(coalesce(role,''))) = 'admin' order by email limit 1;

  -- Sentinel non-stage key, removed again before commit.
  insert into public.settings (key, value) values ('pia_sentinel_check', to_jsonb('x'::text))
    on conflict (key) do update set value = excluded.value;

  perform set_config('request.jwt.claims',
    json_build_object('email', v_student, 'role','authenticated',
                      'iat', extract(epoch from now())::bigint)::text, true);
  execute 'set local role authenticated';
  select count(*) into n_student from public.settings;
  execute 'reset role';

  perform set_config('request.jwt.claims',
    json_build_object('email', v_admin, 'role','authenticated',
                      'iat', extract(epoch from now())::bigint)::text, true);
  execute 'set local role authenticated';
  select count(*) into n_admin from public.settings;
  execute 'reset role';

  delete from public.settings where key = 'pia_sentinel_check';

  -- Student must NOT see the sentinel; admin must.
  if n_student <> 3 then
    raise exception 'PIA ABORT: student sees % settings rows, expected 3 stage flags only.', n_student
      using errcode = 'P0001';
  end if;
  if n_admin < 4 then
    raise exception 'PIA ABORT: admin sees only % settings rows -- admin read is broken.', n_admin
      using errcode = 'P0001';
  end if;

  raise notice 'PIA OK: student sees % (stage flags only); admin sees %.', n_student, n_admin;
end;
$$;

commit;

notify pgrst, 'reload schema';


-- Final report: settings contents + any remaining Tagalog message strings.
select 'settings key' as item, key as detail from public.settings
union all
select 'remaining tagalog', p.proname || ': ' || m[1]
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral regexp_matches(pg_get_functiondef(p.oid),
    '''([^'']{4,200}?(?:[Ww]alang|[Hh]indi|[Bb]awal|[Kk]ailangan|[Pp]wede|[Dd]apat|[Nn]apili|[Mm]asyado|[Ss]andali)[^'']{0,200}?)''','g') as m
 where n.nspname = 'public' and p.prokind = 'f'
   and m[1] !~ '^\s*;?\s*(--|end if|then|v_)'      -- skip inline comments caught mid-body
 order by item, detail;
