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

## External ML service (NOT connected)

Endpoint: `POST https://pia-ml-api.marcstephen444.workers.dev/predict` (a Cloudflare Worker on an individual's account).
Sent, as JSON, after every answer or hint once two answers exist, with a 5 s timeout: seven numbers computed over the last 8 answer events:
`recent_accuracy`, `average_attempts`, `hint_rate`, `average_response_time` (seconds, correct answers only), `correct_response_efficiency`, `consecutive_correct`, `consecutive_wrong`, plus `learn: false`.
Not sent: name, email, student id, session id, question text, answers, tutor, group, OCEAN. The request still exposes the browser's IP address and timing to the third party.
Received: `profile` (`struggling` | `average` | `outstanding`) and `confidence`. The page moves its wording profile at most one level per prediction (immediately at confidence >= 0.95).
Effect: only the tutor's wording bank (greetings, praise, wrong-answer lines, hint prefixes). It does not change questions, grading, hints, topics or the time limit. Without it the game uses its own default, `average`.

## Tutor artwork

Character Selection now uses the game's sprites for pia-open, pia-conscientious, pia-extravert, pia-agreeable and pia-neutral (framed head-and-shoulders in the square card; the file is unchanged). The landing page still shows the old cast art.

pia-calm is NOT decided. Today the game shows the Neuroticism sprite and "Cautious Mentor" wording; Character Selection still shows the old blue-haired boy.
- Option A: pia-calm = the game's Neuroticism persona (anxious black-haired boy, worried wording). All art and wording exist. The labels "PIA Stable / Stress-free / steady / Anchor" no longer fit and need renaming.
- Option B: pia-calm = the existing blue-haired calm boy. No game sprites (happy/sad) or dialogue exist for him; they must be supplied, and the Neuroticism persona is then unused.
