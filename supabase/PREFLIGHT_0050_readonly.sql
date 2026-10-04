-- READ-ONLY. Safe on production: only SELECTs; no student data is read (one row counts accounts so you can tell
-- WHICH project you ran it on: production has many, staging has 2).
-- Run BEFORE applying 0050. Every ok must be true ("0050 not applied yet" is true before 0050).
select 'which project: number of auth accounts' as check_name, true as ok, (select count(*)::text from auth.users) as detail
union all
select 'column profiles.selected_character / group_type',
       (select count(*) = 2 from information_schema.columns where table_schema = 'public' and table_name = 'profiles' and column_name in ('selected_character', 'group_type')), null
union all
select '0038 trigger present (it is what 0050 removes)', exists (select 1 from pg_trigger where tgname = 'trg_pia_no_new_neutral_group' and not tgisinternal), null
union all
select '0050 not applied yet', not exists (select 1 from pg_trigger where tgname = 'profiles_neutral_tutor' and not tgisinternal), null
union all
select 'info: students per group (counts only)', true,
       (select string_agg(coalesce(group_type, '(none)') || '=' || n, ', ' order by group_type) from (select group_type, count(*) n from public.profiles where role = 'student' group by group_type) g)
union all
select 'info: neutral students without the Neutral tutor (0050 does not change them)', true,
       (select count(*)::text from public.profiles where lower(trim(coalesce(group_type, ''))) = 'neutral' and selected_character is distinct from 'pia-neutral')
order by 1;
