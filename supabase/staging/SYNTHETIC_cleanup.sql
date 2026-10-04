-- Removes ONLY the synthetic test student's rows (staging or production). Run when the test is done;
-- then delete the Auth user synthetic.student@example.com in Authentication -> Users.
begin;
delete from public.step_hints  where student_email = 'synthetic.student@example.com';
delete from public.step_events where student_email = 'synthetic.student@example.com';
delete from public.profiles    where email         = 'synthetic.student@example.com';
commit;
