-- ============================================================================
-- PIA 0007 -- AYUSIN ANG NULL NA role (dahilan ng walang laman na roster)
-- ============================================================================
-- Ang handleRegisterStudent() ay hindi kailanman nagtakda ng `role` sa insert,
-- kaya NULL ang role ng bawat estudyanteng ginawa sa dashboard. Ang roster ay
-- sinasala ng .neq('role','admin') -> `role <> 'admin'`, at sa SQL ang
-- NULL <> 'admin' ay NULL -- hindi TRUE. Ang mga row na NULL ang role ay
-- tahimik na naiiwan sa labas.
--
-- Kaya lumabas ang lahat ng 4 na row sa unfiltered fetch pero 0 sa roster:
-- hindi RLS ang may kasalanan, ang three-valued logic.
--
-- LIGTAS ANG BACKFILL: ang mga NULL lang ang hinahawakan. Ang admin mo ay
-- role='admin' na (kaya TRUE ang is_admin()), at ang mga teacher ay 'teacher',
-- kaya wala sa kanilang maaapektuhan.
--
-- Tumatakbo ito sa SQL Editor bilang `postgres`, kaya pinapayagan ito ng
-- trg_enforce_profile_write_scope (current_user <> 'authenticated').
-- ============================================================================

update public.profiles set role = 'student' where role is null;

alter table public.profiles alter column role set default 'student';
alter table public.profiles alter column role set not null;

notify pgrst, 'reload schema';


-- ============================================================================
-- ULAT -- ito ang huling statement kaya ito ang ipapakita ng editor.
-- Dalawang bagay ang sinasagot nito nang sabay:
--   (1) tama ba ang naging role distribution pagkatapos ng backfill, at
--   (2) ANONG COLUMN ANG TOTOONG MERON ang profiles -- ito ang kailangan
--       para maayos ang 42703 na 400 error sa updateStageCounters().
-- ============================================================================
select 'role: ' || role || ' = ' || count(*)::text as report
  from public.profiles group by role
union all
select '--- columns of public.profiles ---'
union all
select string_agg(column_name, ', ' order by ordinal_position)
  from information_schema.columns
 where table_schema = 'public' and table_name = 'profiles';
