-- ============================================================================
-- SCRIPT B -- Patakbuhin ito MAG-ISA, pagkatapos ng Script A.
-- Ito mismo ang query ng loadStudents(). Kung timeout ang problema, dito ito
-- lalabas nang may totoong mensahe -- hindi tulad ng browser na "error
-- loading resource" lang ang naipapakita.
-- ============================================================================
begin;
select set_config('request.jwt.claims',
       '{"email":"personalinstructingagent@gmail.com","role":"authenticated"}', true);
set local role authenticated;

-- Taasan muna ang timeout para makita natin kung TUMATAKBO ba talaga ito,
-- kahit mabagal -- o may ibang error. Sa transaction lang ito.
set local statement_timeout = '120s';

explain (analyze, timing off, summary on)
select * from public.profiles where role is distinct from 'admin';

rollback;
