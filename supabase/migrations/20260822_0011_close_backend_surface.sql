-- ============================================================================
-- PIA 0011 -- ISARA ANG NATITIRANG BACKEND SURFACE
-- ============================================================================
--   PART 1: bawiin ang lahat ng anon grant (telemetry + settings + lahat)
--   PART 2: ayusin ang column-level grant sa profiles (3 legit na block)
--   PART 3: bantayan ang mga admin_* RPC ng internal role check
--   PART 4: ulat
--
-- Isang transaction lang ang lahat. Kung may pumalya, WALANG mababago.
-- ============================================================================

begin;

-- ===========================================================================
-- PART 1 -- ANON
-- Ang `anon` ay ang role ng publishable key na nakikita ng LAHAT sa
-- view-source. Ang DELETE/UPDATE/TRUNCATE doon ay nangangahulugang kayang
-- burahin ng kahit sino sa internet ang buong research data mo nang HINDI
-- naglo-log in. Wala ni isang pahina ang bumabasa ng table bago mag-login --
-- ang isStageOpen() ay tumatakbo pagkatapos ng session -- kaya ang tamang
-- antas ng access ng anon ay WALA.
-- ===========================================================================
revoke all on all tables    in schema public from anon;
revoke all on all sequences in schema public from anon;
revoke all on all functions in schema public from anon;

-- Para hindi na maulit sa mga bagong table/function sa hinaharap.
alter default privileges in schema public revoke all on tables    from anon;
alter default privileges in schema public revoke all on sequences from anon;
alter default privileges in schema public revoke all on functions from anon;


-- ===========================================================================
-- PART 2 -- PROFILES GRANTS
-- "permission denied for table profiles" ang tatlong legit na path. Iyon ay
-- GRANT error, hindi RLS -- ang RLS ay nagbabalik ng 0 row o ng "new row
-- violates row-level security policy".
--
-- Sanhi: column-level ang mga grant ng authenticated, at ang column na
-- idinagdag ng 0008 (ALTER TABLE ADD COLUMN) ay WALANG minamana kahit anong
-- grant. Kaya ang update na humahawak sa is_in_game / current_problem /
-- hints_used ay tinatanggihan bago pa masuri ang RLS.
--
-- Ang tamang antas ay TABLE-level, dahil ang enforcement ay nasa
-- trg_enforce_profile_write_scope -- na nakakakilala ng admin laban sa
-- student, bagay na HINDI kayang gawin ng grant. Hindi ito nagpapaluwag:
-- pinapatakbo lang nito ang tseke sa tamang layer.
-- ===========================================================================
revoke all on public.profiles from authenticated;
grant select, insert, update on public.profiles to authenticated;
-- Sinasadyang WALANG delete: ang admin_delete_user() RPC lang ang bumubura.


-- ===========================================================================
-- PART 3 -- ADMIN RPC GUARD
-- Ang admin_create_auth_user / admin_delete_user / atbp. ay SECURITY DEFINER
-- na WALANG role check, at may EXECUTE ang authenticated. Ibig sabihin, kayang
-- tawagin ng kahit sinong naka-login na estudyante ang admin_delete_user()
-- mula sa console at burahin ang kahit sinong account.
--
-- Hindi ko binabago ang lohika ng kahit alin sa kanila -- hindi ko pa nakikita
-- ang mga katawan nila. Sa halip, bawat isa ay PINAPALITAN NG PANGALAN tungo
-- sa <pangalan>__inner, at isang wrapper na PAREHO ang pangalan at signature
-- ang inilalagay sa harap nito. Kaya:
--   * walang kailangang baguhin sa JS -- pareho ang pangalan at argumento;
--   * hindi nababago ang orihinal na lohika;
--   * ang __inner ay hindi na matatawag ng authenticated.
-- ===========================================================================
do $$
declare
  r          record;
  v_args     text;
  v_params   text;
  v_ret      text;
  v_body     text;
  v_wrapped  int := 0;
  v_skipped  text := '';
begin
  for r in
    select p.oid,
           p.proname,
           pg_get_function_arguments(p.oid)          as decl_args,
           pg_get_function_identity_arguments(p.oid) as ident_args,
           pg_get_function_result(p.oid)             as ret,
           p.proretset,
           p.proargnames,
           p.pronargs
      from pg_proc p join pg_namespace n on n.oid = p.pronamespace
     where n.nspname = 'public'
       and p.prokind = 'f'
       and p.proname like 'admin\_%'
       and p.prosecdef                                        -- SECURITY DEFINER
       and p.proname not like '%\_\_inner'                     -- hindi pa nabalot
       and has_function_privilege('authenticated', p.oid, 'EXECUTE')
       and pg_get_functiondef(p.oid) !~* '(is_admin|current_user_role|pia_caller_role)'
  loop
    -- Kailangan ng pangalan ng parameter para maipasa sa loob. Walang pangalan
    -- = laktawan (at iulat) sa halip na masira ang function.
    if r.pronargs > 0 and (r.proargnames is null or array_length(r.proargnames,1) < r.pronargs) then
      v_skipped := v_skipped || r.proname || ' (walang pangalan ang parameter), ';
      continue;
    end if;

    v_params := case when r.pronargs = 0 then ''
                     else array_to_string(r.proargnames[1:r.pronargs], ', ') end;

    execute format('alter function public.%I(%s) rename to %I',
                   r.proname, r.ident_args, r.proname || '__inner');

    if r.ret = 'void' then
      v_body := format('perform public.%I(%s);', r.proname || '__inner', v_params);
    elsif r.proretset then
      v_body := format('return query select * from public.%I(%s);', r.proname || '__inner', v_params);
    else
      v_body := format('return public.%I(%s);', r.proname || '__inner', v_params);
    end if;

    execute format($f$
      create function public.%I(%s)
      returns %s
      language plpgsql
      security definer
      set search_path = public
      as $inner$
      begin
        if public.pia_caller_role() is distinct from 'admin' then
          raise exception 'PIA: admin lang ang pwedeng tumawag ng %I().'
            using errcode = '42501';
        end if;
        %s
      end;
      $inner$;$f$, r.proname, r.decl_args, r.ret, r.proname, v_body);

    execute format('revoke all on function public.%I(%s) from public, anon, authenticated',
                   r.proname || '__inner', r.ident_args);
    execute format('grant execute on function public.%I(%s) to authenticated',
                   r.proname, r.ident_args);

    v_wrapped := v_wrapped + 1;
  end loop;

  raise notice 'PIA: % admin RPC ang nabalot. Nilaktawan: %',
    v_wrapped, coalesce(nullif(v_skipped, ''), 'wala');
end;
$$;

commit;

notify pgrst, 'reload schema';


-- ===========================================================================
-- PART 4 -- ULAT
-- ===========================================================================
select 'anon: ' || table_name as item, string_agg(distinct privilege_type, ',') as detail
  from information_schema.role_table_grants
 where table_schema = 'public' and grantee = 'anon'
 group by table_name
union all
select 'anon grants', case when not exists (
         select 1 from information_schema.role_table_grants
          where table_schema='public' and grantee='anon')
       then 'WALA NA (tama)' else '*** may natitira pa ***' end
union all
select 'profiles grant: authenticated',
       string_agg(distinct privilege_type, ',')
  from information_schema.role_table_grants
 where table_schema='public' and table_name='profiles' and grantee='authenticated'
union all
select 'admin RPC: ' || p.proname,
       case when pg_get_functiondef(p.oid) ~* 'pia_caller_role' then 'may guard'
            when p.proname like '%\_\_inner' then
                 case when has_function_privilege('authenticated', p.oid, 'EXECUTE')
                      then '*** inner, tawagable pa ***' else 'inner, naka-lock' end
            else '*** WALANG GUARD ***' end
  from pg_proc p join pg_namespace n on n.oid=p.pronamespace
 where n.nspname='public' and p.proname like 'admin\_%'
 order by item;
