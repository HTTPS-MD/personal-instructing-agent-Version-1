-- ============================================================================
-- Ipakita ang BAWAT duplicate na email row nang buo, para makapili ka kung
-- alin ang itatago. READ-ONLY -- walang binabago.
--
-- Sinusuri ang pareho: eksaktong duplicate AT duplicate na case-variant lang
-- ang pinagkaiba (hal. 'Juan@ue.edu.ph' vs 'juan@ue.edu.ph') -- ang huli ay
-- nakakasira rin, dahil lowercase ang iniimbak ng Supabase Auth at eksaktong
-- tugma ang hinahanap ng .eq('email', session.user.email).
-- ============================================================================
with dups as (
  select lower(trim(email)) as norm
    from public.profiles
   group by lower(trim(email))
  having count(*) > 1
)
select p.id,
       p.email,
       p.full_name,
       p.role,
       p.status,
       p.section,
       p.group_type,
       p.is_ocean_done,
       p.ocean_o,
       p.pre_test_score,
       p.post_test_score,
       p.current_stage,
       coalesce(array_length(p.active_devices, 1), 0) as devices,
       -- Alin ang TALAGANG naka-link sa isang auth user? Ito ang row na
       -- makakapag-login. Ang kabila ay orphan.
       exists (select 1 from auth.users u where u.id::text = p.id::text) as linked_to_auth_by_id,
       exists (select 1 from auth.users u where lower(u.email) = lower(p.email)) as auth_user_exists_for_email
  from public.profiles p
  join dups d on d.norm = lower(trim(p.email))
 order by lower(trim(p.email)), p.id;
