#!/bin/bash
# usage: run_chain.sh <dbname>  -- applies the migrations the game depends on, then 0039, on a scratch DB.
HERE="$(cd "$(dirname "$0")" && pwd)"; M="$HERE/../migrations"
"$HERE/run.sh" "$1" "$M/20260822_0001_profile_write_guard.sql" "$M/20260822_0004_server_side_tutoring.sql" \
  "$M/20260822_0005_hotfix_pia_can_enter_stage.sql" "$M/20260929_0028_math_task_bank.sql" \
  "$M/20260929_0029_percentages_go_live.sql" "$M/20260930_0038_control_ocean_only_neutral_persona.sql" \
  "$M/20261003_0039_step_based_game.sql"
# then: psql -h /tmp -p 54329 -U postgres -d <dbname> -f game_0039_test.sql
