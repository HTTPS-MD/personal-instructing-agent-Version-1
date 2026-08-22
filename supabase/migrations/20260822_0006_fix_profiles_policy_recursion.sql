-- ============================================================================
-- PIA 0006 -- AYUSIN ANG INFINITE RECURSION SA PROFILES POLICIES
-- ============================================================================
-- ERROR: 42P17 infinite recursion detected in policy for relation "profiles"
--
-- SANHI: ang policy na `profiles_select_teacher` ay may LITERAL na subquery sa
-- profiles sa loob mismo ng USING clause nito:
--
--   is_teacher()
--   AND NOT (section IS DISTINCT FROM (
--        SELECT t.section FROM profiles t WHERE t.email = current_email()))
--                          ^^^^^^^^ bumabasa ng profiles sa loob ng policy
--                                   ng profiles -- ito ang loop.
--
-- Para masuri ang subquery na iyon, kailangang i-apply ang SELECT policies ng
-- profiles; para magawa iyon, kailangang suriin ang subquery; walang katapusan.
--
-- BAKIT LAHAT ANG APEKTADO, hindi lang ang teacher: ang mga PERMISSIVE policy
-- ay pinagsasama sa pamamagitan ng OR, at SINUSURI ANG LAHAT sa bawat SELECT.
-- Kaya kahit admin ka o estudyante, dinadaanan pa rin ng query mo ang sirang
-- policy na ito. Iyon ang dahilan kung bakit hindi ito mukhang admin-only.
--
-- HINDI NAWAWALA ANG TEACHER ACCESS: ginagawa na ito ng
-- `profiles_select_teacher_section` --
--   current_user_role() = 'teacher' AND section = current_user_section()
--   AND jwt_is_current()
-- -- na hindi bumabasa ng profiles nang inline, at may kasama pang
-- jwt_is_current() na revocation check na WALA sa lumang policy.
--
-- PARA IBALIK ITO (rollback -- babalik ang recursion):
--   create policy profiles_select_teacher on public.profiles
--     for select using (
--       is_teacher() and not (section is distinct from (
--         select t.section from public.profiles t where t.email = current_email())));
-- ============================================================================

drop policy if exists profiles_select_teacher on public.profiles;

notify pgrst, 'reload schema';
