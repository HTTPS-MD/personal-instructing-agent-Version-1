-- ============================================================================
-- PIA 0014 -- TRANSLATE REMAINING TAGALOG MESSAGES (round 2)
-- ============================================================================
-- 0013 covered the functions I authored. This covers the pre-existing admin_*
-- functions, whose message strings I had never seen -- notably the `skipped`
-- reasons returned by admin_grant_stage, which the dashboard renders verbatim
-- in its "Partially Granted" alert.
--
-- Same technique as 0013: read each function's own definition, substitute only
-- the message text, re-execute. Logic cannot drift because the body is the
-- database's own copy.
--
-- Every mapping below is a literal replace, so an entry that does not match is
-- simply a no-op. That makes it safe to include likely variants alongside the
-- two confirmed strings.
--
-- The closing report uses a CORRECTED detector. The one in 0013 was wrong:
-- it included 'ng ', which matches "using " -- and every function here
-- contains `using errcode`, so it flagged all 17 regardless.
-- ============================================================================

do $$
declare
  r     record;
  v_def text;
  v_new text;
  i     int;
  n     int := 0;
  v_map text[][] := array[
    -- confirmed present in admin_grant_stage__inner
    array['Hindi pa tapos ang OCEAN test',        'OCEAN test not yet completed'],
    array['Hindi non-assigned ang grupo',         'Group is not non-assigned'],
    -- likely siblings; no-ops if absent
    array['May napili nang character',            'A character has already been selected'],
    array['Wala pang napiling character',         'No character selected yet'],
    array['Tapos na ang OCEAN test',              'OCEAN test already completed'],
    array['Walang ganitong email',                'No such email'],
    array['Hindi mahanap ang profile',            'Profile not found'],
    array['Hindi mahanap ang user',               'User not found'],
    array['Walang profile',                       'No profile'],
    array['Hindi awtorisado',                     'Not authorized'],
    array['Walang pahintulot',                    'Permission denied'],
    array['Kailangan ng admin',                   'Admin required'],
    array['admin lang ang pwede',                 'admin only'],
    array['Hindi wasto ang',                      'Invalid'],
    array['Hindi kilalang',                       'Unknown'],
    array['Naabot na ang limitasyon para sa problemang ito ngayong araw.',
          'Daily attempt limit reached for this problem.'],
    array['Masyadong mabilis ang mga sagot. Sandali lang po.',
          'Answers are coming in too quickly. Please slow down.'],
    array['Tapos na ang session na ito.',         'This session has already ended.'],
    array['Isang aktibong session lang bawat estudyante.',
          'Only one active session per student.']
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

notify pgrst, 'reload schema';


-- ============================================================================
-- CORRECTED REPORT -- string literals only, and no 'ng '/'ang ' keywords
-- (those matched "using ", which is why 0013's report was useless).
-- Anything listed here is genuinely untranslated user-facing text.
-- Empty result = the backend is fully English.
-- ============================================================================
select p.proname as function_name,
       m[1]      as remaining_tagalog_string
  from pg_proc p
  join pg_namespace n on n.oid = p.pronamespace
  cross join lateral regexp_matches(
        pg_get_functiondef(p.oid),
        '''([^'']{4,200}?(?:[Ww]alang|[Hh]indi|[Bb]awal|[Kk]ailangan|[Pp]wede|[Dd]apat|[Nn]apili|[Gg]rupo|[Tt]apos na|[Mm]asyado|[Ss]andali|[Ii]sang aktibo)[^'']{0,200}?)''',
        'g') as m
 where n.nspname = 'public' and p.prokind = 'f'
 order by p.proname, m[1];
