# PIA Batch 1 requirement checklist

Status values distinguish implementation from verification. Browser checks use isolated fixtures; they do not send email, change accounts, or contact Supabase.

| Requirement | Implementation status | Verification status | Evidence / limitation |
|---|---|---|---|
| 6.1 Admin-created account language | Implemented | Implemented and verified in isolated browser checks | `index.html`, activation dialog and account-access section use admin-owned wording. |
| 7.1 Sign in primary; activation secondary | Implemented | Implemented and verified at 320–1440px | Hero, finale, navbar and mobile menu order updated. |
| 7.2 Navbar visibility and focus retention | Implemented | Implemented and verified in isolated browser checks | `assets/js/nav.js`; uses sticky-header geometry, visual viewport, hit testing, inert/ARIA state. |
| 8.1 Truthful Grade 7/percentage copy | Implemented | Source and screenshot inspected | Unsupported duration, universal tutor choice and outcome claims removed. |
| 8.2 Tutor previews do not persist choices | Already satisfied / preserved | Implemented and verified | `assets/js/agent-select.js` only changes preview UI; isolated test observed no service call. |
| 8.3 Neutral tutor copy | Implemented | Source and screenshot inspected | Placeholder is labelled without implying a lock or future unlock. Backend assignment rules remain unchanged. |
| 9.1 Account access section | Implemented | Implemented and verified | Open section with admin-created-account guidance and ordered actions. |
| 10.1 Activation request states | Implemented | Implemented and verified in isolated browser checks | Validation, pending state, duplicate prevention, neutral accepted copy, resend/change-email, timestamps and 60-second fallback. |
| 11.1 Email-link-only recovery request | Implemented | Implemented and verified in isolated browser checks | Manual recovery-code UI removed from shared recovery dialog. Device-recovery code flow remains separate. |
| 12.1 Verified setup identity | Implemented | Implemented and verified in isolated browser checks | `assets/js/authentication.js` requires provider token/session identity; URL mode and cached sessions cannot authorize. |
| 12.2 Password setup outcomes | Implemented | Implemented and verified in isolated browser checks | Confirmed password failure preserves fields; uncertain password save blocks retry; cleanup can retry without resubmitting password. |
| 13.1 Dialog dismissal and focus | Implemented | Implemented and verified in isolated browser checks | One visible X, inert background, return-to-origin context, Escape and focus restoration. |
| 14–15 Homepage structure/accessibility | Implemented | Implemented but partially unverified | Both themes, reduced motion, responsive overflow, 200% text zoom, touch targets and contrast checked in isolated browser run. Real-device and live integration checks remain unavailable. |
| 14.1 Label wrapping at 200% text zoom | Fixed in this verification pass | Rendered check (`text-zoom-200.png`) | "PASSWORD" label broke mid-word beside "Forgot password?"; `.label-row` in `styles/pages/landing.css` now wraps and keeps words intact. Suite rerun 33/33. |
| 11.2 Repository-managed recovery/activation email templates | Blocked | Source inspection | No template files, `config.toml` or `[auth.email]` settings exist in the repo (only `supabase/functions/admin-set-temp-password` and migrations). Templates are therefore live-managed and were not changed. Migration `20260927_0019` comment says `resetPasswordForEmail()` sends "a link and a code"; if the live template still shows a code or lacks a Reset password button, it must be edited in the Supabase dashboard (needs user approval). |
| 11.3 Device-recovery code flow preserved | Already satisfied | Source inspection (`index.html` device-reset dialog) | Separate from password recovery; untouched. No manual reset-code UI remains in the recovery dialog (grep for reset-code/verify-code strings: none). |
| 14.2 Scroll scrub and marquee removal | Decision recorded, not reverted | Source inspection | Marquee is absent. `data-scrub-words` headings remain; the hero background-video scrub was removed in the earlier implementation. Neither is required by Sections 5-15, and Section 14 lists marquees/parallax as items to avoid. |
| Shared live email/template configuration | Blocked | Unverified | No live emails, templates, migrations, configuration changes or deployment performed. |

Future-module requirements (admin dashboard, teacher roster and final cross-module verification) remain pending for their scheduled batches. Batch 2 is recorded below.


## Verification run (this session)

- Command: `node tests/batch-1-browser.cjs` (Playwright 1.56.1, bundled Chromium via `PIA_CHROME`), isolated: loopback only, Supabase SDK replaced by a fixture, all other requests blocked.
- Result: 33/33 passed, before and after the label fix. Covered: navbar visibility/focus, activation and recovery dialogs, cooldowns, late responses, Escape and focus return, setup page outcomes, 200% text size on a short viewport, long email wrapping, contrast and touch targets in both themes, overflow at 320/343/345/375/768/1280/1440px.
- Screenshots inspected by eye: homepage 1280 dark, 375 light, recovery dialog 320 light and 1440 dark, and 200% zoom. No overflow or overlap seen apart from the fixed label wrap.
- Reduced motion: the suite runs under `reducedMotion: 'reduce'`; the non-reduced motion path was not separately tested.
- Limits: desktop Chromium only (no real device, mobile keyboard, Firefox or Safari); no live Supabase, email delivery, token verification or role routing; mocks are not integration evidence.
- Not run: lint/type/build (the repo has no package.json or configured checks, so not applicable).


---

# Batch 2 — Student screens + tutorial (Sections 16–18)

Branch `codex/batch-2-student-screens`, created from `codex/batch-1-homepage-access` @ `e0bc425`. Harness: `tests/batch-2-browser.cjs` (isolated: loopback only, Supabase SDK replaced by a fixture; the "account" lives in the Node process so two browser contexts act as two devices). Final result: see "Batch 2 final polish" below.

| Req | Implementation | Verification | Evidence / limitation |
|---|---|---|---|
| 16.1 Student pages use homepage design system | Implemented for the three named screens | Rendered in isolated Chromium (screenshots inspected: OCEAN, dashboard, Character Selection at 320-1440px, both themes) | `data-surface="comic"` added to `ocean-test.html`, `character-selection.html`, `student-dashboard.html`. The existing `:root[data-surface="comic"]` token set in `styles/global.css` supplies the same palette, square edges, hard offsets and violet fill as `index.html`. Typography/buttons come from the same global components. Waiting room, assessment-complete and set-new-password were NOT in scope and keep the old surface, so the journey is not yet uniform. |
| 16.2 Logic unchanged | Preserved | Source diff review + OCEAN submit/persistence tests | Scoring, `submit_ocean_results`, localStorage progress, assignment and tutoring code untouched. |
| 16.3 Phone top bar fix (found during rendering) | Fixed | Rendered at 320 and 375px | Sign out was pushed off-screen on Character Selection (status chip + identity). `student-journey.css`: bar can shrink, status chip hidden under 480px. Not verified on a real device. |
| 17.1 Question Map removed | Implemented | Isolated browser test: no `#qnav`, grid, bar, scrim or "question map" text | Markup, handlers (`openMap/closeMap/initQuestionMap`, grid build, `qnav-count`, map-bar meta) and `.qnav/.qgrid/.qmap-*` CSS removed after grepping: no other file referenced them. |
| 17.2 Next/Back only; Submit hidden until final question | Implemented | Isolated browser test across all 50 questions | Submit has `hidden` until question 50; Next is hidden on 50. Arrow keys still map to Back/Next (same actions). Existing rule kept: Submit stays disabled until all 50 are answered. |
| 17.3 Scoring/persistence/submission preserved | Already satisfied | Isolated test: 50x answer 4 sends `p_responses` of fifty 4s to `submit_ocean_results`; reload restores question and selected answer | Server scoring and RLS not exercised (fixture only). |
| 18.1 Tutorial auto-opens once per account, across devices | Implemented | Isolated two-device test (separate contexts, shared fixture account): device A sees it, skip, device B does not; a different account still sees it | `student/js/student-tutorial.js`. **Persistence = Supabase Auth `user_metadata.pia_tutorial_seen_at`**, read with `auth.getUser()` and written with `auth.updateUser({data})`. No table, column, RPC or migration. **Not verified against the live Supabase project** (see dependency below). |
| 18.2 Skip Tutorial highly visible; Skip/Finish/Escape mark seen | Implemented | Isolated tests; asserts `updateUser` is called with only `data`, nothing in localStorage | Outlined 44px button at footer left. Escape = skip. |
| 18.3 Never re-opens automatically | Implemented | Isolated test | If the flag cannot be READ the tutorial does not auto-open (fail quiet). If it cannot be WRITTEN the dialog still closes and nothing claims success; the account may see it again next visit. Both tested. |
| 18.4 Persistent Tutorial/Help control | Implemented | Isolated test: replay, Back/Next/Finish, replay does not write again, focus returns to the button | `#tutorial-btn` in the dashboard top bar, icon-only under 480px with accessible name, >=44px. |
| 18.5 Post-Skip mock cursor / reduced-motion highlight | Implemented | Isolated test, both modes; screenshots inspected | Normal motion: cursor glides to the button and "clicks", then clears. Reduced motion: no cursor; ring + short note (`role=status`). Real Windows/macOS reduced-motion settings not tested. |
| 18.6 Autoplay restrictions | Not applicable | Source inspection | The repo contains no tutorial video/audio, so nothing autoplays. The tutorial is four text steps and cannot be blocked by autoplay policy. If a video is supplied later, autoplay handling must be added then. |
| 18.7 Tutorial content truthful | Implemented | Source comparison with dashboard copy | Only facts already on the page: no timer, type a number (% optional), 2 tries per problem, hints arrive step by step. No "10 problems" claim in the tutorial itself. |

## Batch 2 dependencies and open questions

1. **Tutorial persistence is unverified against live Supabase.** It relies on the Auth API accepting `updateUser({data})` from a student session and `getUser()` returning `user_metadata`. This is a standard supabase-js capability and needs no migration, but I could not confirm it here (no live access). Things to confirm before relying on it: (a) the project does not block metadata updates; (b) `updateUser` does not trip the revocation/`jwt_is_current` checks or the single-active-session logic. I checked that migration 0019's trigger only clears `must_change_password` on a password change, so a metadata-only update does not affect it. user_metadata is user-editable, which is acceptable for a non-security "seen" flag but means it is not research data.
2. **Alternative, only if the user wants it** (not created, requires approval to expand backend scope): a `profiles.tutorial_seen_at timestamptz` column plus a `SECURITY DEFINER` RPC `mark_tutorial_seen()` that sets it from the JWT email, and adding the column to the dashboard's narrow select. This would need a local migration file and a live apply.
3. Observation, not changed: the OCEAN consent screen says it "takes about ten minutes". That claim was removed from the homepage in Batch 1 for lack of evidence; the student-side copy is outside Batch 2's stated scope.

## Batch 2 checks actually run

- `node --check` on changed JS: pass.
- `tests/batch-2-browser.cjs`: 30/30 (OCEAN map/nav/submit/persistence/overflow at 320-1440, tutorial auto-open/skip/finish/Escape/replay/cross-device/failure paths/reduced-motion/cursor, Character Selection render and overflow in both themes, no request to supabase.co).
- `tests/batch-1-browser.cjs`: 33/33 re-run (no regression).
- Lint/type/build: not applicable (no package.json or configured tooling).
- Not verified: live integration, real devices/mobile keyboard, other browsers, Character Selection selection logic (only rendered), waiting room / assessment-complete (out of scope), 200% text zoom on student screens, WCAG contrast measurement on student screens (visual inspection only).


## Batch 2 icon and card audit (follow-up)

Rule applied (spec 13/14, extended to the student screens): a card stays only if it groups a function (an interactive unit or a comparable record); an icon stays only if it carries meaning the text does not, or is the accessible label of an icon-only control. Large icons above text and nested boxes are removed.

**Kept (with reason):** OCEAN question card (the answer unit); Back/Next chevrons (direction); persona cards and preview card (selectable tutors / their detail); dashboard progress card, problem card, tutor card and session tutor panel (functional groups); modal X on the lock-in and sign-out dialogs (the single dismissal); feedback status icon and error-banner icon (non-colour status cue); Tutorial help icon (the only visible content of the button under 480px); stage rail pips on OCEAN/Character Selection (progress state).

**Removed:** Sign out icon (all three screens, text label already present); Submit check, Start play, Hint bulb, Lock-in check icons (redundant with labels); brain and lock glyphs above the OCEAN consent/locked titles; shield icon and the shaded box around the OCEAN privacy disclosure (text unchanged, now an open section with a left rule); the large glyph + centred "hero" in the OCEAN quit, Character lock-in and dashboard sign-out dialogs (now left-aligned plain text; the redundant second heading was dropped); trophy glyph on the summary; the decorative "live" dot in the dashboard stage chip (it implied live status that nothing measures); the gate card around OCEAN consent, the OCEAN progress card, the saving/error state card, the dashboard start card and summary card (now open sections); the stat boxes on the start and summary screens (now `<dl>` with a top rule). Unused icon symbols removed.

**Unchanged on purpose:** research/assessment/selection/navigation logic. The sign-out dialog keeps its title, Go back/Sign out buttons and Escape/backdrop behaviour. `.modal-hero*` stays in `styles/global.css` (still used by Admin pages); a small `.modal-text` rule was added there.

**Verification:** 11 added isolated browser checks (icons present per screen and state, card/hero absence, flat computed styles, description lists, dialogs plain, no overflow) at 375 and 1280px in both themes, plus screenshots inspected. The first run of these checks passed while the layout was actually broken (a stray `</div>` I introduced closed the start card early and emptied the summary); the screenshots caught it, it was fixed, and layout assertions were added.

**Remaining violations / limits (not fixed):**
1. Waiting room, assessment-complete and set-new-password still use the old gate card and glyph (`.gate-glyph`, `.gate-wrap` card). They are outside the three screens named in section 16; they were deliberately left intact. Until they are reworked, the journey is visually uneven.
2. Character Selection still shows the `.stage-rail` pips plus the tutor preview card and six persona cards; these are judged functional, but that is a judgement call.
3. The post-Skip tutorial note briefly overlays the heading on phones (transient, covers no control).
4. The dashboard tutorial-eligible "Section Earth" identity block and avatar initials are unchanged (identity, functional).
5. Only desktop Chromium; no real device, other browsers, 200% zoom or contrast measurement on these screens.


## Batch 2 final polish

**Files changed in this polish pass:** `student/js/student-tutorial.js`, `student/js/character-selection.js`, `styles/pages/student-dashboard.css`, `tests/batch-2-browser.cjs`, `docs/batch-1-requirements-checklist.md`.

1. **Post-Skip note (phones).** The floating note could sit over the page heading. It is now an in-flow status row inserted directly under the top bar (`.tutorial-callout`, `role="status"`, text filled a tick after insertion so it is announced), so it cannot overlap the heading or any control at any width. Reduced-motion fallback kept: ring on the Tutorial button plus this note, no cursor. Normal motion still shows the mock cursor. Asserted at 320 and 375 (reduced and normal), 768 and 1440: the note sits below the top bar, inside the viewport, overlaps none of heading / Start / Tutorial / Sign out / tutor card / facts, causes no overflow, then disappears and clears the highlight.
2. **Long names.** A 90-character first name clipped past the right edge of the dashboard heading at 320px (the first geometry assertion missed it; the screenshot showed it). `.start-hello` now wraps with `overflow-wrap: anywhere`; the test now also fails on text overflowing its own box.
3. **Character Selection lock-in dialog keyboard gap (found while testing).** The irreversible-choice dialog had no Escape, no initial focus, no Tab containment and no focus return. Added, without touching selection logic: focus starts on the safe "Let me look again" button, Tab stays inside, Escape = look again, focus returns to the Lock in button. This is a keyboard/a11y fix, not a navigation or research change.

**The three remaining screens: first recorded as out of scope; SUPERSEDED, see "Waiting Room / Assessment Complete / Set New Password layouts" below (the user then explicitly authorised them).**

| Screen | What it looks like now (inspected in rendered screenshots, 375 and 1280, both themes) | Why not changed |
|---|---|---|
| Waiting Room (`waiting-room.html`) | Rounded card, large clock glyph in a circle, shaded info box, Sign out icon | Not named in section 16; no Batch 2 acceptance behaviour depends on it. Its logic redirects students by stage and was not touched. |
| Assessment Complete (`assessment-complete.html`) | Rounded card, large check glyph, pill Continue button with arrow icon | Same. It is the screen right after OCEAN, so the visual seam is real and visible. |
| Set New Password (`set-new-password.html`) | Rounded card, large key glyph, rounded fields and button | Same, and it is part of the forced temporary-password security flow; restyling it risks authentication behaviour, so it should be its own reviewed change. |

All three render without horizontal overflow (checked). Recommended follow-up (needs your go-ahead): apply `data-surface="comic"` and the same icon/card rules to these three, preserving their scripts.

**Final icon/card decisions** are as listed in the audit section above; nothing was added back. Icons kept: Back/Next chevrons (direction), modal X (dismissal), feedback/error status icons (state), Tutorial help icon (the only content of the button on phones). No decorative icons added. Cards kept only for functional units (question card, tutor/persona/preview cards, progress/problem/tutor panels).

**Verification (isolated, `tests/batch-2-browser.cjs`; Batch 1 regression `tests/batch-1-browser.cjs`):** see the results line appended below after the final run. Added in this pass: note geometry at 5 viewports/themes, the three out-of-scope screens (render + overflow, 6 checks), 200% text zoom on OCEAN and the dashboard/tutorial at 375x667, computed text contrast >= 4.5 in dark and light for OCEAN, tutorial and dashboard text and buttons, long-name overflow, quit-dialog and lock-in-dialog keyboard/Escape/focus. Screenshots were inspected after the runs, which is what caught the two layout defects above.

**Limitations (unchanged):** real devices and mobile keyboards, Firefox/Safari, assistive-technology testing and live integration are not tested. Contrast uses a computed-colour check on selected text, not a full audit, and does not cover disabled controls or text over images. Tutorial persistence remains **unverified against live Supabase** (Auth `user_metadata`, see Batch 2 dependencies above); only the isolated fixture was exercised. No migrations, templates, emails or deployments were touched.

**Final results (this session, isolated Chromium, loopback only):** Batch 2 suite 59/59; Batch 1 regression 33/33 (run after the last source change; the only edit since was a wait added to one Batch 2 test). `node --check` on all `student/js/*.js`: pass. Lint/type/build: not applicable (no tooling in the repo). Widths covered: 320, 375, 768, 1280, 1440 (OCEAN, dashboard, tutorial, Character Selection), both themes; reduced motion on and off.

**Batch 2 status (before the three-screen follow-up below): partially complete.** The three named screens (OCEAN, Character Selection, Tutoring Dashboard) and the tutorial are implemented and pass the isolated checks with screenshots inspected. Not complete: the three journey screens above remain on the old design (recorded as out of scope), tutorial persistence is unverified against live Supabase, and there is no real-device, other-browser or assistive-technology testing.


## Waiting Room / Assessment Complete / Set New Password layouts (explicitly authorised follow-up)

**Files changed:** `student/html/waiting-room.html`, `student/html/assessment-complete.html`, `student/html/set-new-password.html`, `student/js/waiting-room.js` (presentation only: a `setWaitingFor()` helper fills one fact row inside the existing three stage branches), `styles/pages/student-journey.css`, `tests/batch-2-browser.cjs`, this file. `assessment-complete.js` and `set-new-password.js` were NOT edited, so token verification, password policy and session handling are byte-for-byte as before.

All three: `data-surface="comic"` (homepage tokens, themes, reduced motion inherited), Sign out icon removed, no centred gate card, no large glyph.

| Screen | Layout now | Preserved | Deliberately not added |
|---|---|---|---|
| Waiting Room | Open section; status heading (existing three title variants); existing explanation; description list: Status = Not open yet, Your stage = Waiting room, Waiting for = questionnaire / character selection / tutoring dashboard (same branch that picks the title); existing "no need to refresh" note as plain text. Clock orb, pulse animation, info icon and note box removed. | Automatic redirect when the stage opens (tested), realtime listener, stage routing. | No primary action: the existing flow has none (it redirects by itself), so none was invented. Group/research condition is not shown. |
| Assessment Complete | Open section: heading and lede unchanged word for word, one Continue action (arrow kept: direction). Check glyph and card removed. | Continue destination still set by the existing `resolveStudentRedirect` (tested: resolves to the dashboard for a Control fixture). | **No facts list: there is no result data to show.** By design (research integrity, migration 0018) no score, trait or tutor reaches the student, so nothing was invented. |
| Set New Password | One solid form surface (the existing `.gate-wrap`, now comic-styled), left-aligned title/description; verified email shown as plain text (set by the script from the session profile, unchanged); both fields, requirements list always visible (never placeholders), accessible Show passwords checkbox, single submit. Key glyph and the shaded identity box removed. | Field errors + focus, pending "Saving…", confirmed success then redirect, failure keeps fields, unflagged account is sent on, `updateUser` receives only `{password}` (all tested against a mock; the mock clears `must_change_password` to stand in for the migration-0019 trigger, so the trigger itself is not verified). | No new fields, steps or destinations. |

Two small non-colour cues were added in CSS only (script untouched): a met password rule shows "· met", and an error status shows "Error:" before its text.

Icons left on these screens: Continue arrow (direction), the four rule dots (status), nothing else except the shared header.

**Verification:** 17 new isolated checks plus updated old ones. Final runs: **Batch 2 suite 76/76, Batch 1 regression 33/33.** Widths 320/375/768/1280/1440 and both themes on all three screens (overflow, surface, glyph/card absence, icon list, single action). Screenshots inspected for each screen after the runs. 

**Status:** Waiting Room, Assessment Complete and Set New Password are implemented and verified in the isolated harness. Remaining limits: no real device or other browsers; live token verification, real password change and the live DB trigger are untested (no live access); Waiting Room facts reflect existing page logic only; contrast on these three screens was inspected visually, not computed (the computed 4.5:1 check covers OCEAN, tutorial and dashboard). **Batch 2 overall: implemented and isolated-verified for all six student screens; still limited by unverified live tutorial persistence and no real-device testing.**
