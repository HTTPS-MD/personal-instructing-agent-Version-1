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
| Shared live email/template configuration | Blocked | Unverified | No live emails, templates, migrations, configuration changes or deployment performed. |

Future-module requirements (student screens, admin dashboard, teacher roster and final cross-module verification) remain pending for their scheduled batches.
