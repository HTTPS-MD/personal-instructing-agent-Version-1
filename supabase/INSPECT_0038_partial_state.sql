-- READ-ONLY. Run in the Supabase SQL Editor after the failed 0038 run to see whether any of it stuck.
-- Nothing here changes data. If every "applied" column is false, nothing was committed.
select
  (pg_get_functiondef('public.pia_can_enter_stage(boolean,text,text,text)'::regprocedure) ~ 'control')      as part1_stage_rule_applied,
  (pg_get_functiondef('public.submit_ocean_results(integer[])'::regprocedure) ~ 'v_is_control')              as part2_ocean_next_stage_applied,
  exists (select 1 from pg_trigger where tgname = 'trg_pia_no_new_neutral_group')                            as part3_neutral_trigger_exists,
  exists (select 1 from pg_trigger where tgname = 'trg_pia_control_stage_guard')                             as part4_control_guard_exists,
  to_regclass('public.pia_0038_snapshot') is not null                                                        as leftover_snapshot_table,
  (select count(*) from public.profiles)                                                                     as profile_rows;
