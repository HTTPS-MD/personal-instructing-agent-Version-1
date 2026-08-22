-- ============================================================================
-- PIA 0008 -- TIYAKING UMIIRAL ANG MGA TRACKING COLUMN
-- ============================================================================
-- Ang updateStageCounters() ay bumabagsak sa 42703 (undefined column) ->
-- HTTP 400. Umiiral ang `id`, kaya `current_stage` o `is_in_game` ang wala.
--
-- Sa halip na hulaan kung alin, IDEMPOTENT ang lahat ng ALTER sa ibaba: ang
-- `add column if not exists` ay walang ginagawa kung meron na. Kaya naaayos
-- nito ang 400 anuman ang nawawala, at ligtas itong patakbuhin kahit kumpleto
-- na ang table.
--
-- Ito ang buong hanay ng column na TALAGANG isinusulat o sinasala ng app --
-- kung may kulang pa rito, ang susunod na 400 ay galing sa syncGameProgress()
-- o sa Active Game view, hindi na sa mga counter.
--
-- Ang `is_in_game`, `current_problem`, `current_difficulty`, `hints_used`, at
-- `consecutive_correct` ay nasa student whitelist ng
-- trg_enforce_profile_write_scope. Ang `current_stage` at `stage_started_at`
-- ay SADYANG WALA doon -- sa set_student_stage() RPC lang sila nababago.
-- ============================================================================

alter table public.profiles add column if not exists current_stage       text;
alter table public.profiles add column if not exists stage_started_at    timestamptz;
alter table public.profiles add column if not exists is_in_game          boolean not null default false;
alter table public.profiles add column if not exists current_problem     int     not null default 0;
alter table public.profiles add column if not exists current_difficulty  text;
alter table public.profiles add column if not exists hints_used          int     not null default 0;
alter table public.profiles add column if not exists consecutive_correct int     not null default 0;

notify pgrst, 'reload schema';


-- ============================================================================
-- ULAT -- isang row bawat item, kaya HINDI ito maaaring ma-truncate.
-- Dalawang bagay:
--   (1) SINO ang may role='admin'. Dalawa sila. Kilala mo ba pareho?
--   (2) Ang totoong listahan ng column ng profiles.
-- ============================================================================
select '1. ADMIN' as sort_key, email as detail
  from public.profiles where lower(trim(role)) = 'admin'
union all
select '2. TEACHER', email
  from public.profiles where lower(trim(role)) = 'teacher'
union all
select '3. column', column_name
  from information_schema.columns
 where table_schema = 'public' and table_name = 'profiles'
 order by sort_key, detail;
