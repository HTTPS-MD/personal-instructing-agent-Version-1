# Neutral and Control: policy change and handling plan for existing records

Status: **prepared and tested locally only.** Nothing has been applied to any live database, pushed or merged.
Migration: `supabase/migrations/20260930_0038_control_ocean_only_neutral_persona.sql`
Read-only inspection: `supabase/INSPECT_neutral_and_control.sql`

## Confirmed policy

1. **Control is OCEAN-only.** A Control student takes OCEAN and nothing else: no Character Selection, no Tutoring Dashboard, whatever a stage's open flag or a section grant says.
2. **Neutral (`pia-neutral`) is a tutor persona**, not a research condition. Free Choice students can pick it in Character Selection (already in the picker). Assigned students can be given it. Nobody new may be given the group value `neutral`.
3. **Existing `group_type = 'neutral'` records are not silently changed.**

## What the migration does (and does not)

| | Change |
|---|---|
| `pia_can_enter_stage` | Control is refused `Tutoring Dashboard`. Every other group is evaluated exactly as in 0005. `set_student_stage`, the stage-time heartbeat (0035) and the student route guards all read this one function. |
| `submit_ocean_results` | Redefined from the 0018 text with one change: a Control student's next stage is `Waiting Room` (always permitted) instead of `Tutoring Dashboard`. Scoring, validation, storage and grants are unchanged. |
| Trigger `trg_pia_no_new_neutral_group` | Refuses to insert a profile as `neutral` or to change an existing row **to** `neutral`. A row that is already `neutral` can still be edited (name, section, stage, scores) and can be moved out of neutral. |
| Profiles | **No row is updated.** The migration snapshots every profile at its start and its postflight aborts (rolling everything back) if any row differs at the end. |
| Not touched | `question_bank`, `settings`, `stage_overrides`, other RPCs, RLS, consent/assent rules. |

Behaviour for existing **neutral** rows after the migration: unchanged from today. The stage rule has never had a neutral special case, so they take OCEAN, skip Character Selection and enter the Tutoring Dashboard, exactly like Assigned. Their `selected_character`, section, stage and scores are untouched.

## Handling plan for existing Neutral records

**Step 0 (now, before applying anything):** run `supabase/INSPECT_neutral_and_control.sql` in the Supabase SQL editor (it is one read-only transaction) and send back the result sets. It lists every neutral student with section, stage, OCEAN status, persona, test-score presence and tutoring seconds, summarises them by section, lists Control students already in or past the dashboard, and checks for a live CHECK constraint on `group_type` and for how `admin_grant_stage__inner` decides eligibility.

**Step 1 (apply 0038):** after you approve the diff. The migration changes no student. Its notice prints how many neutral students it left alone and how many Control students are currently in the dashboard.

**Step 2 (per-student decisions, only by you, after reading the inspection output).** Pick one per neutral student or per section; none is automatic:

| Option | Effect | When it fits |
|---|---|---|
| A. **Leave as `neutral`** (default) | Behaves as Assigned; shown as "EXP · Neutral (legacy)" in the console; excluded from nothing. | Analysis already treats these students as a third cell and splitting them would damage that. |
| B. **Convert to Assigned + persona `pia-neutral`** | `group_type = 'assigned'`, `selected_character = 'pia-neutral'`. Matches the new model (neutral is a persona for Assigned students). | You want one clean two-condition design from now on. Decide whether past data stay labelled as before in analysis. |
| C. **Convert to Free Choice** | `group_type = 'non-assigned'`. Only sensible for a student who has not yet reached the dashboard (they would be sent to Character Selection). | A student who has not started. |

Option B/C would be a deliberate, reviewed update (a short SQL file listing exact emails, committed for audit), never a bulk default. The migration and the Admin console both leave the value alone until then. The Edit participant dialog shows a legacy-neutral student with "EXP · Neutral (legacy, unchanged)" selected; saving an unrelated edit does not send `group_type`. An admin may move that student to Assigned, Free choice or Control from that dialog; nobody can be moved **into** neutral.

## Control students who are already in the Tutoring Dashboard

The new rule locks them out from their next navigation or stage write, but nothing is moved for them by the migration. For each one listed by query 4 of the inspection script, decide: keep the data as recorded and let them stop (they will see the thank-you screen), or treat the time already spent as a deviation to note. Their `current_stage` stays `Tutoring Dashboard` in the database until they pass through the waiting room (which records `Waiting Room`) or an admin resets them; the student pages already send them to the thank-you screen regardless, and the server refuses further `Tutoring Dashboard` writes and heartbeats for them.

## Admin console changes (this branch)

- Register participant offers Assigned, Free choice and Control (no Neutral).
- Edit participant shows a Neutral choice only for a student who already has it, labelled legacy, and does not re-send `group_type` unless it is changed.
- The group filter and badges say "Neutral (legacy)".
- Stage Controls policy table (still read-only): Control is Available / Locked / Locked; Assigned and Free choice as before; a "Neutral (legacy records)" row behaves as Assigned; the footer explains Neutral as a persona. Stage Controls access rules were not changed.
- Class Sections status now has only **Online** and **Offline**; where there is not enough evidence it shows "—" with the accessible text "Status unavailable".

## Student pages (this branch)

`function.js` adds `isControlGroup` and the dashboard prerequisite excludes Control. After OCEAN a Control student goes to the thank-you screen, which has no Continue button and says "Your answers have been saved. That is everything for now." The waiting room, the dashboard URL and the Character Selection URL all send a Control student there.

## Not done and why

- **No admin control assigns a persona to Assigned students.** The repository has none today (assigned students show a generic monogram when no persona is set; an admin can already write `selected_character` directly, which the write guard allows). I did not add a persona picker because that decides research assignment behaviour; say if you want it.
- **`admin_grant_stage__inner` is not in the repository.** Whether a section grant defers to `pia_can_enter_stage` cannot be confirmed here; the migration prints a REVIEW notice if the live function does not call it, and the inspection script reports it.
- Nothing was run against the live database. See the checklist for what was tested locally.
