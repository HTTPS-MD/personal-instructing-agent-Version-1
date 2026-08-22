-- ============================================================================
-- THE QUESTION THAT ACTUALLY MATTERS:
--   Can a STUDENT read the answer key?
-- Not theory -- this impersonates a real student and counts what they can see.
--
-- No temp table: SET LOCAL ROLE changes the role's search_path, which made the
-- earlier version unable to resolve its own temp table. A pg_temp function is
-- session-scoped and returns rows via a tuplestore instead.
--
-- READ-ONLY. Run the whole file in one go.
-- ============================================================================

create or replace function pg_temp.pia_probe()
returns table (target text, rows_visible text)
language plpgsql
as $fn$
declare
  v_student text;
  t         text;
  n         bigint;
begin
  select email into v_student
    from public.profiles
   where lower(trim(coalesce(role, 'student'))) = 'student'
   order by email limit 1;

  if v_student is null then
    target := '(no student found)'; rows_visible := 'cannot run probe';
    return next; return;
  end if;

  perform set_config('request.jwt.claims',
    json_build_object('email', v_student, 'role', 'authenticated',
                      'iat', extract(epoch from now())::bigint)::text, true);

  foreach t in array array[
      'math_answers', 'math_hints', 'tutoring_attempts', 'math_attempt_log',
      'ocean_submissions', 'professors', 'sections', 'settings',
      'problem_serves', 'hint_consumptions', 'profiles']
  loop
    if to_regclass('public.' || t) is null then
      target := t; rows_visible := '(table does not exist)';
      return next;
      continue;
    end if;

    begin
      execute 'set local role authenticated';
      execute format('select count(*) from public.%I', t) into n;
      execute 'reset role';

      target := t;
      rows_visible := case
        when n = 0 then ' 0  -- locked'
        else '*** ' || n || ' ROWS READABLE ***'
      end;
      return next;

    exception when others then
      begin execute 'reset role'; exception when others then null; end;
      target := t;
      rows_visible := 'blocked: ' || left(replace(sqlerrm, E'\n', ' '), 60);
      return next;
    end;
  end loop;
end;
$fn$;

select target, rows_visible from pg_temp.pia_probe() order by target;

drop function pg_temp.pia_probe();
