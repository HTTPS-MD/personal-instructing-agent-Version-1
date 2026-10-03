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
| Trigger `trg_pia_control_stage_guard` | No writer, a `SECURITY DEFINER` admin RPC included, can move a Control student into Character Selection or the Tutoring Dashboard: the write is kept at the student's current stage (with `stage_started_at` and `is_in_game`). It does not raise, so a section grant still completes for the section's other students. A Control student already in the dashboard is not moved. |
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

## Tutor persona assignment (Admin)

Research group (`profiles.group_type`) and tutor (`profiles.selected_character`) are separate fields in the console.

- **Register participant** and **Edit participant** show a "Tutor persona" select **only for Assigned students**: Not assigned yet, PIA Open, PIA Structure, PIA Dynamic, PIA Empath, PIA Stable, **PIA Neutral**. It defaults to Not assigned yet. Nothing is chosen for anyone.
- Saving writes `selected_character` **only when the admin changed it** in that dialog (to a listed key, or null for "Not assigned yet"). An unrelated edit never sends it. A key that is not in the list is refused before any write.
- Changing a student's group never clears or rewrites the tutor. A non-Assigned student who already holds a tutor sees it read-only with the note "changing the group does not clear this". Be aware of the consequence: a Free choice student who already has a tutor skips Character Selection (existing rule), so look before moving an Assigned student with a tutor to Free choice.
- A failed save keeps the dialog open, says "The tutor was not saved: ..." on the field and in a toast, and can be retried.
- The participant profile shows the tutor (or "Not assigned yet" / "Not chosen yet"). "Allow character re-selection" now appears only for Free choice students, because for an Assigned student it would clear the tutor an admin assigned.
- Server side nothing new is required: admins can already write `selected_character` and the stage rule already treats an Assigned student as dashboard-eligible with or without a tutor. The database does not restrict the value to the six keys; the console does.
- Student route (tested): Assigned + `pia-neutral` goes to the dashboard and sees "PIA · your tutor"; Character Selection and the waiting room send them to the dashboard; Assigned with no tutor yet is not sent to Character Selection and is not given one; a Free choice student who picked PIA Neutral reaches the dashboard, one who has not picked goes to Character Selection.

## Finding: can an Admin grant bypass the Control OCEAN-only rule?

**Verified against the live database: NO. I cannot reach it.** This session has no database credentials, and I did not use the public client key for it. So the actual definition of `admin_grant_stage__inner` was **not read**. What can be said:

- **From the repository:** the function is not defined in any migration (it was created outside the files; 0033 only wraps it, 0014 only rewrites its message strings). Those strings show it has its own eligibility checks (OCEAN not completed; "Group is not non-assigned" for Character Selection), i.e. hard-coded rules, not necessarily a call to `pia_can_enter_stage`. The console's own comment says it "resets the correct prerequisite flag per stage". Nothing in the repository shows a Control check for the Tutoring Dashboard.
- **Therefore it must be assumed that a section grant to the Tutoring Dashboard could move a Control student in** until the definition proves otherwise. I modelled that on the scratch database with a stand-in function that has no group check: before 0038 the grant moved a Control student into the dashboard; after 0038 the same grant left them at their stage.
- **Local migration adjustment made:** `trg_pia_control_stage_guard` (see the table above). It enforces the rule at the row, so the answer does not depend on the unknown function. Limitation: the grant's returned "granted" list may still name the Control student although their stage did not change, so the console's "granted" count can overstate. A proper fix (filter and report them as skipped) needs the real function body.
- **To close this out:** run `supabase/INSPECT_neutral_and_control.sql` (read-only); query 7 lists every function that writes `current_stage` with `calls_stage_rule` / `checks_control`, query 8 prints the full text of `admin_grant_stage__inner` and `admin_grant_stage`, query 9 lists the triggers on `profiles`. Send queries 7 and 8 back; I will then adjust the function or the report.

## Not done and why

- The tutor assignment is not restricted to the six keys in the database (a CHECK constraint could collide with unknown live values); the console restricts it.
- Nothing was run against the live database. See the checklist for what was tested locally.
