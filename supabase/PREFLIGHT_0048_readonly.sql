-- READ-ONLY. Safe on production: only SELECTs; no student data is read (one row counts accounts so you
-- can tell WHICH project you ran it on: production has many, staging has 2).
-- Run BEFORE applying 0048. Every ok must be true ("0048 not applied yet" is true before 0048).
select 'which project: number of auth accounts' as check_name, true as ok, (select count(*)::text from auth.users) as detail
union all
select 'function tutoring_status (0045)', exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace where n.nspname = 'public' and p.proname = 'tutoring_status'), null
union all
select 'table app_config / question_bank', to_regclass('public.app_config') is not null and to_regclass('public.question_bank') is not null, null
union all
select 'realtime publication exists', exists (select 1 from pg_publication where pubname = 'supabase_realtime'), null
union all
select '0048 not applied yet', not exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
                                           where n.nspname = 'public' and p.proname = 'tutoring_status'
                                             and pg_get_functiondef(p.oid) like '%seconds_to_close%'), null
order by 1;
