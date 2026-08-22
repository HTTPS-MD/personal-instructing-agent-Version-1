-- ============================================================================
-- THE FINAL GATE: not the NUMBER of policies, but what they SAY.
-- `profiles` had 7 policies -- one recursive, three silently negating the
-- revocation check. The count was never the evidence.
-- READ-ONLY. One row per policy, so nothing truncates.
-- ============================================================================
select p.tablename,
       p.policyname,
       p.cmd,
       p.roles::text as for_roles,
       case
         when coalesce(p.qual, 'true') = 'true' and p.cmd in ('SELECT', 'ALL')
              then '*** OPEN TO ALL AUTHENTICATED ***'
         when p.tablename in ('math_answers', 'math_hints')
              then '!! review: answer/hint data'
         else 'conditional'
       end as risk,
       coalesce(p.qual, '(no USING clause)') as using_expr
  from pg_policies p
 where p.schemaname = 'public'
   and p.tablename <> 'profiles'          -- already fully reviewed
 order by
   case when p.tablename in ('math_answers', 'math_hints') then 0 else 1 end,
   p.tablename, p.cmd, p.policyname;
