-- Removes ONLY the load-test accounts: loadtestNNN@example.com (tests/load-100-students.cjs).
-- Every other email is untouched. Run in the SQL Editor when the test is done.
--
-- It finds every public table with a student_email / email column, deletes the matching rows
-- (repeating passes so foreign keys resolve in any order), then removes the Auth users.
-- Ends with a count of what is left; all three numbers should be 0.
begin;

do $$
declare
  r record;
  pass int;
  v_left int;
begin
  for pass in 1..6 loop
    for r in
      select c.table_name, c.column_name
        from information_schema.columns c
        join information_schema.tables t
          on t.table_schema = c.table_schema and t.table_name = c.table_name and t.table_type = 'BASE TABLE'
       where c.table_schema = 'public'
         and c.column_name in ('student_email', 'email')
         and c.table_name <> 'profiles'
    loop
      begin
        execute format('delete from public.%I where lower(%I) like %L', r.table_name, r.column_name, 'loadtest%@example.com');
      exception when foreign_key_violation then
        null; -- a later pass will retry once the children are gone
      end;
    end loop;
    begin
      delete from public.profiles where lower(email) like 'loadtest%@example.com';
    exception when foreign_key_violation then
      null;
    end;
  end loop;

  select count(*) into v_left from public.profiles where lower(email) like 'loadtest%@example.com';
  if v_left > 0 then
    raise exception 'LOADTEST cleanup: % profile rows are still referenced elsewhere; nothing was committed.', v_left;
  end if;
end;
$$;

delete from auth.users where lower(email) like 'loadtest%@example.com';

select (select count(*) from public.profiles where lower(email) like 'loadtest%@example.com') as profiles_left,
       (select count(*) from auth.users      where lower(email) like 'loadtest%@example.com') as auth_users_left,
       (select count(*) from public.profiles) as all_profiles_remaining;

commit;
