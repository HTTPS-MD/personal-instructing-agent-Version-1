# Student-number door: test checklist (real Supabase, NOT production)

The door was written and rehearsed against an in-memory simulation
(`tests/sim`). These steps prove it against a real Supabase project. Do them on a
**test or staging project**, or with **one test student** if there is only one
project. Nothing here is needed for the simulation.

## What is not yet proven
1. The SQL of migration `20261012_0052_student_number_door.sql`.
2. `verifyOtp` with a `token_hash` from `generateLink` (the code tries type
   `magiclink`, then `email`).
3. Creating the auth user of a student who never activated (an unknown trigger,
   `handle_new_student_auth`, runs on new auth users).
4. `claim_student_session` and the idle sign-out after a session opened this way.

## 0. Before you start
- [ ] You are on the test project (check the URL in `assets/js/function.js`).
- [ ] Migrations up to `0051` are applied (0052 needs `pia_caller_role()`,
      `jwt_is_current()`, `current_email()` and `pia_auth_user_id()`).
- [ ] You have one test student (profile with a section) and one admin account.

## 1. Apply and deploy
- [ ] Run `0052` in the SQL editor. Expect: `NOTICE: PIA 0052 OK ...`. If it aborts,
      nothing was changed; read the message.
- [ ] `supabase functions deploy join-with-number --no-verify-jwt`
- [ ] In the SQL editor, as the admin, load one student number:
      `select public.admin_import_student_numbers('[{"email":"<test student email>","number":"20231230101"}]'::jsonb);`

## 2. The door, in order
Open `admin/html/checkin.html` as the admin, and `index.html` in another browser
or a private window as the student.

| # | Do | Expect |
|---|---|---|
| 1 | Student: Enter student number, type the number | "Check-in has not started yet. Please wait." No name shown. |
| 2 | Admin: Start check-in for the student's section | Section shows "check-in open". |
| 3 | Student: type a wrong 11-digit number | "We could not find you in today's check-in." |
| 4 | Student: type the right number | "Is this you?" with the name and section. |
| 5 | Student: Yes | "Waiting to be let in". |
| 6 | Admin: wait up to 4 seconds | The student appears in the list, **not ticked**. |
| 7 | Admin: tick, "Let in selected" | "1 student let in." |
| 8 | Student: wait a few seconds | Lands on the next game page. |
| 9 | Student: close the tab, open the site again | **Not** offered "Continue to dashboard". |
| 10 | Student: sign in again, then let the page idle (or force it) | Idle warning at 14 minutes, sign-out at 15. |
| 11 | Second browser as the same student, let in again | The first browser is signed out within about 10 seconds. |
| 12 | Admin: Stop check-in while a student waits | The waiting student sees "Check-in is closed." |

## 3. If something fails
- Step 8 hangs on "Waiting": look at the function's logs. Likely `generateLink`
  or `verifyOtp`; tell me the exact error.
- Step 8 says "This account is not set up yet": the student has no profile row.
- Step 4 never shows the name: the number was not saved, or the section text on the
  profile differs from the check-in's section (spaces, case).
- A student who never activated cannot be let in: the auth-user creation failed;
  send me the function log line.

## 4. Roll back
The rollback statements are at the bottom of the migration. The old sign-in still
works on `main` and on the branch `fix/pick-bubble-img`.
