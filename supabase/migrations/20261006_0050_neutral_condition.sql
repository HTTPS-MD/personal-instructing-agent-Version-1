-- PIA 0050: "Neutral" is a research condition again, chosen by the admin when registering a student.
--
-- 0038 refused every NEW assignment to group_type 'neutral' ("a persona, not a condition"). The research now
-- wants it as a condition of its own:  Neutral = the Assigned workflow without the OCEAN-based choice.
--   OCEAN -> Tutoring Dashboard -> Game, and the tutor is ALWAYS the Neutral one (pia-neutral).
-- (Assigned: the tutor follows the highest OCEAN trait, 0041. Free choice: the student picks. Control: OCEAN only.)
--
-- WHAT THIS CHANGES
--   1. The 0038 trigger that refused new neutral rows is removed.
--   2. A row trigger makes the tutor of a neutral student pia-neutral, on insert and whenever the group or the
--      tutor is written: the OCEAN result never picks it (0041 only touches Assigned), and nobody can give a
--      neutral student another tutor. A student MOVED OUT of neutral loses the persona the group gave them, so
--      the next group's own rule applies (Assigned: after their OCEAN; Free choice: they choose).
-- WHAT IT DOES NOT CHANGE
--   Stage rules, the game, scoring, the learning profile, Control, existing rows (no profile is updated here).
--   Routing already treated 'neutral' as an experimental group: no Character Selection, then the dashboard once a
--   tutor is saved -- which the trigger now does at registration.
begin;

do $$
begin
  if to_regclass('public.profiles') is null
     or not exists (select 1 from information_schema.columns where table_schema = 'public'
                     and table_name = 'profiles' and column_name = 'selected_character') then
    raise exception 'PIA 0050 requires public.profiles.selected_character.';
  end if;
end;
$$;

drop trigger if exists trg_pia_no_new_neutral_group on public.profiles;
drop function if exists public.pia_no_new_neutral_group();

create or replace function public.pia_neutral_tutor()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if lower(trim(coalesce(new.group_type, ''))) = 'neutral' then
    new.selected_character := 'pia-neutral';
  elsif tg_op = 'UPDATE'
        and lower(trim(coalesce(old.group_type, ''))) = 'neutral'
        and lower(trim(coalesce(new.group_type, ''))) is distinct from 'neutral'
        and old.selected_character = 'pia-neutral'
        and new.selected_character is not distinct from old.selected_character then
    new.selected_character := null;
  end if;
  return new;
end;
$$;

revoke all on function public.pia_neutral_tutor() from public, anon, authenticated;

drop trigger if exists profiles_neutral_tutor on public.profiles;
create trigger profiles_neutral_tutor
  before insert or update of group_type, selected_character on public.profiles
  for each row execute function public.pia_neutral_tutor();

commit;
