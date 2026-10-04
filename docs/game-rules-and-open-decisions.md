# Step-by-step game: rules kept, and decisions still open

Status: local only. Migration `20261003_0039_step_based_game.sql` is NOT applied to any live database.

## Rules of the attached game, and where each lives now

| Attached game (pia-test-main/index.html) | Now |
|---|---|
| One session time limit, `app_config.time_limit` minutes, fallback 600 s; one continuous deadline across questions and topics | `game_windows` (server). `app_config.time_limit` added by 0039 (default 10). Shown as "Time left" in the progress card. |
| At expiry inputs are disabled, the tutor says "Time is up!", a "Time limit reached" dialog shows limit / started / finished / spent | Server refuses answers and hints (`time_expired`). Same dialog (alert dialog, not dismissible), plus polite screen-reader announcements at 5 min, 1 min, 30 s and at expiry. |
| "Try Again" reloads the current problem (steps restart, errors and hints zeroed) with a new time limit; topic progress kept | `restart_after_expiry()`. Each expired window is logged. |
| No question-count ending; every question once, shuffled, then again; never the same one twice in a row | No ending. Fewest-seen-this-session first; repeats get their own problem id. |
| 2 steps (Topic 1) / 3 steps (Topics 2-3); working accepted then a final value; hint button after 2 wrong; 3 tiers per step | Unchanged from the first draft. |
| Upgrade after `min_questions` with accuracy >= mastery; downgrade after `max_errors` non-accurate in a row; student accepts or refuses | Unchanged. |
| Session row logged PASSED when errors < max errors (score 100, else 50) | `step_states.passed` / `score`. |

Deliberate differences (flag if you disagree):
- The deadline is wall-clock on the server, so a reload or sign-out gives no extra time. The game kept its timer in the page and a reload restarted everything; resume is a requirement here.
- Topic and topic progress persist per student across visits (the game restarted at Topic 1 on every load).
- The game's end-of-session summary screen is gone: the game has no ending. `finalizeStageTime` is no longer called by the page, because nothing ends the stage; heartbeat time tracking continues. Confirm that is acceptable for the stage-time research data.
- `^` is not accepted in working; questions without steps are skipped (no browser-side guessing).

## Tutor wording profile: the pia-ml-api model, reached only through an Edge Function

Flow: **student's browser -> Supabase Edge Function `learning-profile` -> ML service (our Cloudflare account)**. The page never contacts the service, holds no secret, and the CSP does not allow its host.
- **Model and inference are the original's**, copied verbatim into `ml-service/src/entry.py` (the block between the BEGIN/END VERBATIM markers equals the original `src/entry.py`; `ml-service/ORIGINAL_entry.py` is the untouched copy and `ml-service/tests/test_ml_service.py` checks both, plus 2000 random inputs against the original's `/predict`).
- **What changed is only the exposure** (the source's own risks: `learn:true` rewrote shared centroids, CORS `*`, no authentication): bearer-token only, no CORS headers, no `learn`, no model update, no KV writes, exactly seven numeric features (anything else is rejected), reply is only `profile` + `confidence`, no logging, no `GET /model`.
- **Numbers** come from the database, not the browser: migration 0044 `get_learning_features(session_id)` computes the seven rolling numbers from `step_events`, `step_hints` and `problem_serves`, run AS the student (the game's guard applies: Control, teachers, signed-out callers refused). They contain no identity.
- **The Edge Function** (`supabase/functions/learning-profile`) accepts only `{session_id}`, forwards exactly the seven numbers with the secret `PIA_ML_TOKEN`, and returns only `profile`, `confidence`, `source`. Fewer than two answers: `average` without calling the service. Any failure: the page keeps its wording. Until `PIA_ML_URL` and `PIA_ML_TOKEN` are set it answers 503, so the feature stays off.
- Wording only; the page moves one level at a time. Never questions, grading, hints, topics or the time limit.
- Differences from the browser version, because the server measures: response time = gap since the previous recorded event or hint (else since the question was served), capped at 300 s; a revisited step counts once. The old live model's centres may have drifted in its KV store: seed the new KV (read-only use) from the old service's `GET /model` if you want them; otherwise the original cold-start centres apply.
- Remaining unverified: the Python Worker has only been run with a stand-in for Cloudflare's `workers` module, not on Cloudflare itself (do `wrangler dev` then staging first); Cloudflare logging/retention settings of our account; research approval of adaptive wording.

What the attached game did, for reference:
- Endpoint: `POST https://pia-ml-api.marcstephen444.workers.dev/predict` (a Cloudflare Worker on an individual's account).
- Sent after every answer or hint once two answers exist (5 s timeout), as JSON: seven numbers over the last 8 answer events: `recent_accuracy`, `average_attempts`, `hint_rate`, `average_response_time` (correct answers only), `correct_response_efficiency`, `consecutive_correct`, `consecutive_wrong`, plus `learn: false`.
- Not sent: name, email, student id, session id, question text, answers, tutor, group, OCEAN. The third party still sees the browser's IP address and request timing.
- Returned: `profile` (`struggling` | `average` | `outstanding`) and `confidence`. The wording profile moves at most one level per prediction (immediately at confidence >= 0.95).
- Effect: only the tutor's wording bank. Not questions, grading, hints, topics or the time limit.

## Tutor artwork: one set, the attached game's sprites

`pia-calm` is the attached game's Neuroticism character (the worried black-haired boy, "Cautious Mentor" wording). Character Selection, the landing cast, the landing tutor stage and the game all show the sprite from `assets/images/tutors/<key>/` for all six keys, Neutral included. The landing uses `assets/images/cast/<key>.webp`, the same sprite padded onto a 600x840 transparent canvas to fit its fixed 3:4 frames (no pixel is edited or recoloured). The old `cast/char-N.webp` files are now unused and can be deleted.
Labels that contradicted the character were replaced: "PIA Stable / Stress-free / steady / Anchor / Calm & steady" are now "PIA Careful / Cautious / careful / Cautious / Checks every step" (Character Selection, landing, the game's name line, and the Admin tutor dropdown's display text). Internal keys (`pia-calm` etc.) and Admin assignments are unchanged.

## Stage-time tracking: what it measures (checked, nothing changed in the database)

Checked on a scratch PostgreSQL with migration 0035 (`supabase/scratch/stage_time_check.sql`):
- `record_heartbeat('Tutoring Dashboard')` IS cumulative across repeated visits: 30 s credited per 30 s ping, a gap over 45 s credits nothing and restarts the clock (away time is not counted), and a second visit adds to the same `tutoring_time`.
- `finalize_stage_time` permanently locks `tutoring_time`; after it, later sessions add nothing. The game page therefore never calls it: not at expiry, not at Try again, not at sign-out (verified by test). Nothing else in the repository calls it for the dashboard.

Ways the research report could still mislabel the number:
1. `tutoring_time` is "seconds the Tutoring Dashboard tab was visible", counted from page load. It includes the start screen, the tutorial, the topic-offer dialog and the time-limit dialog, so it is not time spent answering.
2. The game's time limit is wall-clock on the server (a hidden tab still burns it), while the heartbeat pauses when the tab is hidden. The two totals will not match, and neither is "play time".
3. `profiles.is_in_game` was cleared only when a session ended; this game has no end, so it would stay true forever. Fixed in the page for sign-out only (display flag). Closing the tab or the 15-minute idle sign-out still leave it true, so the admin's "Active session" can be stale.
4. Because nothing finalizes the stage, `tutoring_time` keeps growing on any later dashboard visit.

Proposed fixes (NOT implemented; need your decision): (a) report play time from `game_windows` (sum of each window's started_at to ended_at/deadline) and per-question `time_taken_ms`, and label `tutoring_time` "time on the dashboard page"; (b) add a read-only report view with those columns; (c) have the admin "Active session" require a heartbeat in the last ~90 s as well as `is_in_game`; (d) decide whether an admin action should lock `tutoring_time` when the study ends.

## Game screen: the original layout, in the landing theme

`#screen-session` is the attached game's own arrangement, not a redesign: the tutor on the left (classroom video with the halftone overlay, speech bubble above the sprite, Request Hint at the bottom), the chalkboard problem and the worksheet step strips (ruler edge, "Step n of N" pill, Your Step Solution, Submit Step) in the centre on graph paper, and on the right the ruled notebook with the Solved Questions and Error Log tabs, sticky-note errors (last five) and the dashed "No slip-ups so far. Nice!" empty state. Clicking a solved question reviews it in the workspace with "Back to current question" (and Escape). The topic card (Accept / Refuse) and the "Time Limit Reached!" card (Try Again) keep the game's arrangement. Stacks tutor, workspace, notebook on a phone, as the original did.
Skinned only: the landing's ink/paper/violet/volt, Space Grotesk / Inter / JetBrains Mono, square edges with a solid violet offset, both themes (`styles/pages/student-game.css`). The classroom video is the landing page's own hero film (the attached folder's `hero-classroom-1080.mp4` was not in it); it does not play for reduced motion.
Removed from the original: the top strip (timer, ML test badge, Start Over, guest badge), the colour picker, the character choice, the large header. The clock moved into the chalkboard corner.
Not restored (kept server-driven): client-side answer checking, the question-bank download, URL student id, the external ML calls, the game's own Supabase connection.
