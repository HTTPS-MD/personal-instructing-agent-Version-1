-- Phase A (BEFORE 0049, committed): a finished question scored the OLD way (100), to prove 0049 keeps history.
insert into profiles(email, full_name, role, group_type, is_ocean_done, selected_character, parental_consent, student_assent) values
 ('admin@s.test','Admin','admin',null,true,null,true,true),
 ('old@s.test','Old','student','assigned',true,'pia-open',true,true);
insert into question_bank(difficulty, question, final_answer, hint, points) values
 ('EASY', 'What is 10% of 50?', '5', '{"defaultHint":"d","steps":[{"prompt":"p1","answer":"0.1","hint1":"a","hint2":"b","hint3":"c"},{"prompt":"p2","answer":"5","hint1":"m"}]}', 10);
insert into served_questions(session_id, student_email, problem_id, problem_number, question_id, topic, student_topic, question, final_answer, steps)
 select 'aaaaaaaa-0000-0000-0000-000000000001','old@s.test','qb-'||id,1,id,1,1,question,final_answer,'[]'::jsonb from question_bank limit 1;
insert into step_states(session_id, student_email, problem_id, completed, errors, hints, score, passed)
 select 'aaaaaaaa-0000-0000-0000-000000000001','old@s.test','qb-'||id,true,0,0,100,true from question_bank limit 1;
