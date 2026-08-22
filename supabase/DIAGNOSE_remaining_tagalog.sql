-- ============================================================================
-- What Tagalog text ACTUALLY remains, and is it a message or a comment?
--
-- The 0013 report was wrong: its regex included 'ng ' which matches "using ",
-- and every one of these functions contains `using errcode`. It also matched
-- Tagalog in COMMENTS, which the migration never intended to touch.
--
-- This pulls out the real STRING LITERALS instead -- the only text that ever
-- reaches a user. READ-ONLY.
-- ============================================================================

-- (1) Per function: did any of 0013's source strings survive the replace?
select p.proname as function_name,
       case when pg_get_functiondef(p.oid) ~ 'PIA: (walang|hindi|bawal|kailangan)'
                 or pg_get_functiondef(p.oid) like '%device limit lang%'
            then '*** OLD MESSAGE STILL PRESENT ***'
            else 'messages translated ok' end as message_status,
       case when pg_get_functiondef(p.oid) ~ '(--[^\n]*(ang|ng|sa|mga|kaya|dati|iyon))'
            then 'has Tagalog comments (cosmetic only)'
            else 'comments clean' end as comment_status
  from pg_proc p join pg_namespace n on n.oid = p.pronamespace
 where n.nspname = 'public' and p.prokind = 'f'
   and pg_get_functiondef(p.oid) like '%PIA%'
 order by message_status desc, p.proname;
