-- Kumpirmahin na nakakabasa na ang admin sa pamamagitan ng RLS, bago pa
-- subukang mag-login sa browser. Nagtatapos sa rollback -- ligtas.
begin;
select set_config('request.jwt.claims',
       '{"email":"personalinstructingagent@gmail.com","role":"authenticated"}', true);
set local role authenticated;
select email, role, section from public.profiles
 where email = 'personalinstructingagent@gmail.com';
rollback;
