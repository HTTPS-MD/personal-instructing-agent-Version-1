-- READ-ONLY. Second preflight for 0039: can the game actually be served from question_bank?
-- Needs 0029 applied (uses public.pia_parse_hint). Run after PREFLIGHT_0039_readonly.sql.
select * from (
  select 'questions with valid steps: ' || t.lbl as chk,
         case when n.c = 0 and t.lbl = 'EASY (topic 1)' then 'BLOCKER' when n.c = 0 then 'WARN' else 'OK' end as status,
         n.c || ' usable (need the first ' || t.req || ' steps, each with an answer)' as detail
  from (values ('EASY (topic 1)','EASY',2),('MEDIUM (topic 2)','MEDIUM',3),('HARD (topic 3)','HARD',3)) t(lbl, dif, req)
  cross join lateral (
    select count(*) c from public.question_bank q
     where upper(q.difficulty) = t.dif and trim(coalesce(q.question,'')) <> ''
       and to_regprocedure('public.pia_parse_hint(text)') is not null
       and jsonb_typeof(public.pia_parse_hint(q.hint)->'steps') = 'array'
       and jsonb_array_length(public.pia_parse_hint(q.hint)->'steps') >= t.req) n
  union all
  select 'questions WITHOUT usable steps (never served by the game)', case when x.c = 0 then 'OK' else 'WARN' end,
         x.c || ' of ' || x.total || ' question_bank rows; add steps in Admin > Math Task'
  from (select count(*) total, count(*) filter (where not (
          jsonb_typeof(public.pia_parse_hint(q.hint)->'steps') = 'array'
          and jsonb_array_length(public.pia_parse_hint(q.hint)->'steps') >= case upper(q.difficulty) when 'EASY' then 2 else 3 end)) c
        from public.question_bank q) x
) r order by case status when 'BLOCKER' then 0 when 'WARN' then 1 else 2 end, chk;
