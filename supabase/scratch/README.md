# Scratch tests for migration 0039 (step-based game)
Not the real database. `stub_live_only_objects.sql` stands in for objects that exist only live
(tutoring_attempts, start_game_session, jwt_is_current, ...). Run `run_chain.sh <db>` then
`game_0039_test.sql` (expects 70 passed / 0 failed). Browser suites: `tests/game-browser.cjs`
(mock in `tests/fixtures/game-supabase-mock.js`); run with Node + Playwright and PIA_CHROME set.
