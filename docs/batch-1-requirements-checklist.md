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

Future-module requirements (student screens, admin dashboard, teacher roster and final cross-module verification) remain pending for their scheduled batches.


## Verification run (this session)

- Command: `node tests/batch-1-browser.cjs` (Playwright 1.56.1, bundled Chromium via `PIA_CHROME`), isolated: loopback only, Supabase SDK replaced by a fixture, all other requests blocked.
- Result: 33/33 passed, before and after the label fix. Covered: navbar visibility/focus, activation and recovery dialogs, cooldowns, late responses, Escape and focus return, setup page outcomes, 200% text size on a short viewport, long email wrapping, contrast and touch targets in both themes, overflow at 320/343/345/375/768/1280/1440px.
- Screenshots inspected by eye: homepage 1280 dark, 375 light, recovery dialog 320 light and 1440 dark, and 200% zoom. No overflow or overlap seen apart from the fixed label wrap.
- Reduced motion: the suite runs under `reducedMotion: 'reduce'`; the non-reduced motion path was not separately tested.
- Limits: desktop Chromium only (no real device, mobile keyboard, Firefox or Safari); no live Supabase, email delivery, token verification or role routing; mocks are not integration evidence.
- Not run: lint/type/build (the repo has no package.json or configured checks, so not applicable).
