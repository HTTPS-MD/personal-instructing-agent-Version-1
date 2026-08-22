-- ============================================================================
-- PIA 0002 -- SERVER-SIDE OCEAN SCORING  (fixes CRITICAL 2)
-- ============================================================================
-- Dati, ang browser ang KUMU-COMPUTE at NAGSU-SULAT ng ocean_e/a/c/n/o. Kahit
-- ilipat lang natin ang WRITE sa isang RPC, kaya pa ring mag-POST ng gawa-gawang
-- E/A/C/N/O ng estudyante. Kaya ang PINAPADALA na ngayon ay ang 50 raw na
-- Likert responses, at ang SERVER ang nag-i-score gamit ang IPIP-50 key.
--
-- BONUS PARA SA THESIS: itinatago na ang per-item responses. Dati, itinatapon
-- ang mga ito pagkatapos mag-compute -- kaya imposibleng gawin ang Cronbach's
-- alpha o anumang item analysis. Ngayon, meron ka nang raw data.
-- ============================================================================

create table if not exists public.ocean_submissions (
  id           bigint generated always as identity primary key,
  email        text        not null,
  responses    smallint[]  not null,
  ocean_e      smallint    not null check (ocean_e between 0 and 40),
  ocean_a      smallint    not null check (ocean_a between 0 and 40),
  ocean_c      smallint    not null check (ocean_c between 0 and 40),
  ocean_n      smallint    not null check (ocean_n between 0 and 40),
  ocean_o      smallint    not null check (ocean_o between 0 and 40),
  submitted_at timestamptz not null default now(),
  constraint ocean_submissions_50_items check (array_length(responses, 1) = 50)
);

create index if not exists ocean_submissions_email_idx on public.ocean_submissions (email);

alter table public.ocean_submissions enable row level security;

-- Walang INSERT/UPDATE/DELETE policy: ang SECURITY DEFINER na RPC lang ang
-- nagsusulat dito. Ang admin lang ang nakakabasa (para sa data export).
drop policy if exists ocean_submissions_admin_read on public.ocean_submissions;
create policy ocean_submissions_admin_read on public.ocean_submissions
  for select to authenticated
  using (public.pia_caller_role() = 'admin');

revoke all on public.ocean_submissions from anon, authenticated;
grant select on public.ocean_submissions to authenticated;


-- Binabasa ang stage flag anuman ang naka-store na hugis (jsonb true,
-- jsonb "true", o boolean) -- katulad ng ginagawa ng isStageOpen() sa JS.
create or replace function public.pia_stage_open(p_key text)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select coalesce(
    (select trim(both '"' from s.value::text) = 'true'
     from public.settings s where s.key = p_key limit 1),
    false);
$$;

revoke all on function public.pia_stage_open(text) from public, anon;
grant execute on function public.pia_stage_open(text) to authenticated;


-- ============================================================================
-- submit_ocean_results(p_responses)
--   p_responses: 50 na Likert item (1..5), nasa pagkakasunod ng questions[]
--                array sa ocean-test.js.
--   Nagbabalik ng { ocean_e, ocean_a, ocean_c, ocean_n, ocean_o, next_stage }.
-- ============================================================================
create or replace function public.submit_ocean_results(p_responses integer[])
returns jsonb
language plpgsql
security definer
set search_path = public
as $$
declare
  v_email   text := auth.jwt() ->> 'email';
  v_profile public.profiles%rowtype;
  r         integer[] := p_responses;   -- integer[] (hindi smallint[]) para
                                        -- maayos ang JSON array coercion ng PostgREST
  v_e int; v_a int; v_c int; v_es int; v_n int; v_o int;
  v_needs_character boolean;
  v_next_stage text;
begin
  if v_email is null then
    raise exception 'PIA: walang authenticated session.' using errcode = '42501';
  end if;

  select * into v_profile from public.profiles where email = v_email;
  if not found then
    raise exception 'PIA: walang profile para sa session na ito.' using errcode = '42501';
  end if;

  -- Isang beses lang. Ang admin retake flow ang nagse-set pabalik ng
  -- is_ocean_done = false kapag pinayagan nilang umulit ang estudyante.
  if coalesce(v_profile.is_ocean_done, false) then
    raise exception 'PIA: naisumite na ang OCEAN test mo. Humingi ng retake sa admin.'
      using errcode = '42501';
  end if;

  -- Istriktong validation ng hugis ng input.
  if r is null or array_length(r, 1) is distinct from 50 then
    raise exception 'PIA: kailangan ng eksaktong 50 na sagot (natanggap: %).',
      coalesce(array_length(r, 1), 0) using errcode = '22023';
  end if;

  if exists (select 1 from unnest(r) v where v is null or v < 1 or v > 5) then
    raise exception 'PIA: bawat sagot ay dapat nasa 1..5.' using errcode = '22023';
  end if;

  -- IPIP-50 scoring key -- port ng dating client-side na computation sa
  -- ocean-test.js (kasama ang Emotional Stability -> Neuroticism inversion).
  -- Lahat ng lima ay may theoretical range na 0..40.
  v_e  := 20 + r[1]  - r[6]  + r[11] - r[16] + r[21] - r[26] + r[31] - r[36] + r[41] - r[46];
  v_a  := 14 - r[2]  + r[7]  - r[12] + r[17] - r[22] + r[27] - r[32] + r[37] + r[42] + r[47];
  v_c  := 14 + r[3]  - r[8]  + r[13] - r[18] + r[23] - r[28] + r[33] - r[38] + r[43] + r[48];
  v_es := 38 - r[4]  + r[9]  - r[14] + r[19] - r[24] - r[29] - r[34] - r[39] - r[44] - r[49];
  v_n  := 40 - v_es;
  v_o  := 8  + r[5]  - r[10] + r[15] - r[20] + r[25] - r[30] + r[35] + r[40] + r[45] + r[50];

  -- Susunod na stage -- sa server na napagpapasyahan, hindi na sa browser.
  v_needs_character :=
    lower(trim(coalesce(v_profile.group_type, ''))) in ('non-assigned', 'non_assigned')
    and v_profile.selected_character is null;

  if v_needs_character then
    v_next_stage := case when public.pia_stage_open('stage_char')
                         then 'Character Selection' else 'Waiting Room' end;
  else
    v_next_stage := case when public.pia_stage_open('stage_dash')
                         then 'Tutoring Dashboard' else 'Waiting Room' end;
  end if;

  insert into public.ocean_submissions (email, responses, ocean_e, ocean_a, ocean_c, ocean_n, ocean_o)
  values (v_email, r::smallint[], v_e, v_a, v_c, v_n, v_o);

  update public.profiles set
    is_ocean_done    = true,
    ocean_e          = v_e,
    ocean_a          = v_a,
    ocean_c          = v_c,
    ocean_n          = v_n,
    ocean_o          = v_o,
    current_stage    = v_next_stage,
    stage_started_at = now()
  where email = v_email;

  return jsonb_build_object(
    'ocean_e', v_e, 'ocean_a', v_a, 'ocean_c', v_c, 'ocean_n', v_n, 'ocean_o', v_o,
    'next_stage', v_next_stage);
end;
$$;

revoke all on function public.submit_ocean_results(integer[]) from public, anon;
grant execute on function public.submit_ocean_results(integer[]) to authenticated;
