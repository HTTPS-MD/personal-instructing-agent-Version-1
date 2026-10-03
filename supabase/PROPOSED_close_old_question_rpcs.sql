-- ============================================================================
-- PROPOSED, NOT A MIGRATION -- close the two-try question calls from 0029
-- ============================================================================
-- Run only when ALL of these are true:
--   1. 0038 (Control OCEAN-only) and 0039 (step-based game) are applied.
--   2. Every caller has moved to the 0039 calls. In the repository the only
--      caller was student/js/student-dashboard.js; check deployed pages and
--      any other client (grep the live site's JS for the five names).
--   3. The Batch 1-3 suites and the game suite pass against the 0039 database.
-- These calls enforce the old whole-answer, two-try rule. Left open, a student
-- could use them to bypass the step rules.
-- To undo: grant execute on the same functions to authenticated.
-- ============================================================================
revoke execute on function public.serve_next_question(uuid)               from authenticated;
revoke execute on function public.check_question_answer(uuid, text, text) from authenticated;
revoke execute on function public.consume_question_hint(uuid, text)       from authenticated;
revoke execute on function public.reveal_question_solution(uuid, text)    from authenticated;
revoke execute on function public.record_question_result(uuid, text)      from authenticated;
