-- ============================================================================
-- Bakit walang laman ang admin roster?
-- Sinusuri ang BAWAT helper function bilang ang admin, sa loob ng totoong RLS
-- context. Nagtatapos sa rollback -- ligtas sa production.
--
-- PALITAN ang email sa ibaba kung iba ang admin account mo.
-- ============================================================================
begin;

select set_config('request.jwt.claims',
       '{"email":"personalinstructingagent@gmail.com","role":"authenticated"}', true);
set local role authenticated;

-- (1) Ano ang ibinabalik ng bawat helper? Ang NULL o FALSE dito ang sagot.
--     Dynamic ang pagtawag para hindi bumagsak ang buong script kung may
--     helper na wala o iba ang pangalan.
create temp table helper_probe(helper text, result text) on commit drop;

do $$
declare
  fns text[] := array['is_admin()', 'current_user_role()', 'jwt_is_current()',
                      'current_email()', 'is_teacher()', 'current_user_section()',
                      'pia_caller_role()'];
  f text; v text;
begin
  foreach f in array fns loop
    begin
      execute 'select (public.' || f || ')::text' into v;
      insert into helper_probe values (f, coalesce(v, '<<< NULL'));
    exception when others then
      insert into helper_probe values (f, 'ERROR: ' || left(sqlerrm, 90));
    end;
  end loop;
end;
$$;

select * from helper_probe;

-- (2) Ilang row ba talaga ang nakikita ng admin? Ito ang eksaktong query ng
--     loadStudents() sa admin-dashboard.js.
select count(*) as rows_admin_can_see
  from public.profiles where role is distinct from 'admin';

-- (3) Kung 0 ang (2): alin sa dalawang admin policy ang pumapasa?
select (select public.is_admin())                        as policy_admin_all_passes,
       (select public.current_user_role() = 'admin'
               and public.jwt_is_current())              as policy_select_admin_passes;

rollback;
