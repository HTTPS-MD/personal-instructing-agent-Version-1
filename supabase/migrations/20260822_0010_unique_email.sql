-- ============================================================================
-- PIA 0010 -- UNIQUE(email) SA PROFILES
-- ============================================================================
-- PATAKBUHIN LANG PAGKATAPOS MABURA ANG DUPLICATE. Tumatanggi itong tumakbo
-- habang may natitirang duplicate -- sadya iyon: ang pagpili kung aling row
-- ang buburahin ay desisyon mo, hindi awtomatiko.
--
-- BAKIT MAHALAGA ITO, higit pa sa maayos na UI:
--   * Ang LAHAT ng telemetry table (tutoring_attempts, math_attempt_log,
--     ocean_submissions, problem_serves, hint_consumptions) ay naka-key sa
--     student_email bilang TEXT. Sa dalawang row na iisa ang email, walang
--     paraan para malaman kung kanino ang isang session.
--   * Ang .maybeSingle() -- ginagamit sa login at sa requireStudentSession() --
--     ay NAG-E-ERROR kapag higit sa isa ang tumugma. Hindi makaka-login ang
--     estudyanteng may duplicate.
--   * Ang saveBatchScores() ay gumagamit ng .upsert(..., {onConflict:'email'}).
--     KAILANGAN nito ng tunay na UNIQUE constraint sa `email` -- hindi sapat
--     ang unique index sa isang expression. Kaya idinagdag ang dalawa sa ibaba.
-- ============================================================================

begin;

-- (1) HARANG: tumigil kung may duplicate pa rin.
do $$
declare
  v_dups text;
begin
  select string_agg(norm || ' (' || cnt || ' rows)', ', ')
    into v_dups
    from (select lower(trim(email)) as norm, count(*) as cnt
            from public.profiles
           group by lower(trim(email))
          having count(*) > 1) d;

  if v_dups is not null then
    raise exception
      'PIA ABORT: may duplicate pa: %. Patakbuhin muna ang DIAGNOSE_duplicate_emails.sql at burahin ang tamang row.',
      v_dups using errcode = 'P0001';
  end if;
end;
$$;

-- (2) I-normalize sa lowercase/trimmed. Lowercase ang iniimbak ng Supabase
--     Auth, at eksaktong tugma ang hinahanap ng .eq('email', user.email) --
--     kaya ang 'Juan@ue.edu.ph' sa profiles ay tahimik na sumisira ng login.
--     Ligtas ito rito: kadedeklara pa lang natin na walang case-variant dups.
update public.profiles
   set email = lower(trim(email))
 where email is distinct from lower(trim(email));

-- (3) Ang tunay na UNIQUE constraint -- ito ang kailangan ng
--     upsert(onConflict:'email').
alter table public.profiles drop constraint if exists profiles_email_key;
alter table public.profiles add  constraint profiles_email_key unique (email);

-- (4) Karagdagang sapin: pumipigil sa case-variant na duplicate sa hinaharap
--     ('A@x.com' vs 'a@x.com'), na hindi nahuhuli ng plain UNIQUE.
drop index if exists public.profiles_email_lower_uidx;
create unique index profiles_email_lower_uidx on public.profiles (lower(email));

commit;

notify pgrst, 'reload schema';


-- Ulat: dapat 0 ang duplicate, at dapat nakalista ang dalawang constraint.
select 'natitirang duplicate' as item, count(*)::text as value
  from (select lower(trim(email)) from public.profiles
         group by lower(trim(email)) having count(*) > 1) d
union all
select 'kabuuang profiles', count(*)::text from public.profiles
union all
select 'index: ' || indexname, 'ok'
  from pg_indexes
 where schemaname = 'public' and tablename = 'profiles'
   and indexname in ('profiles_email_key', 'profiles_email_lower_uidx');
