/**
 * ============================================================================
 * PIA SYSTEM — PRE-PAINT SIGN-IN GUARD
 * ============================================================================
 * Loaded from <head> WITHOUT defer on the admin, teacher and student
 * dashboards: a signed-out visitor is sent back to the front door before a
 * single pixel of the dashboard is painted.
 *
 * This is a routing courtesy, not the security boundary. Row-level security
 * and the async session check in each page's own script (requireStudentSession,
 * the admin role lookup) are what actually keep data out of reach.
 *
 * It lives in a file rather than an inline <script> so the site's
 * Content-Security-Policy can forbid inline script entirely (_headers).
 * ==========================================================================*/
(function () {
    'use strict';

    function enforceAuthGuard() {
        var email = null;
        try { email = localStorage.getItem('pia_user_email'); } catch (e) { /* storage blocked */ }
        if (!email) {
            /* Staff pages open the staff sign-in directly; student pages the
               ordinary one. */
            var staff = /\/(admin|teacher)\//.test(window.location.pathname);
            window.location.replace(staff ? '../../index.html?signin=staff' : '../../index.html');
        }
    }

    enforceAuthGuard();

    /* A back-button restore from the bfcache does not re-run scripts, so the
       page could reappear after sign-out. Re-check on every show. */
    window.addEventListener('pageshow', function (event) {
        if (event.persisted) { enforceAuthGuard(); }
    });
})();
