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

Branch `codex/batch-2-student-screens`, created from `codex/batch-1-homepage-access` @ `e0bc425`. Harness: `tests/batch-2-browser.cjs` (isolated: loopback only, Supabase SDK replaced by a fixture; the "account" lives in the Node process so two browser contexts act as two devices). Result: 30/30; Batch 1 suite re-run 33/33.

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
