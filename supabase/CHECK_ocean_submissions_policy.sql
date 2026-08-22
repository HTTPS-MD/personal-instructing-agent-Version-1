-- Does 0002's ocean_submissions_admin_read policy still exist?
-- Zero rows = the policy is missing: the table is locked to everyone
-- including admins, so per-item OCEAN data is unreachable from the app.
select policyname, cmd, roles::text as for_roles, qual as using_expr
  from pg_policies
 where schemaname = 'public' and tablename = 'ocean_submissions';
