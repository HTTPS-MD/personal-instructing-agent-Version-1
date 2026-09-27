/**
 * ============================================================================
 * PIA SYSTEM — EMAIL-LINK CATCHER (landing page only)
 * ============================================================================
 * Loaded from index.html's <head> WITHOUT defer, before the Supabase SDK.
 *
 * Every auth email Supabase sends (activation, invite, password reset) ends
 * by redirecting the student to a page with the result in the URL:
 *
 *     /#access_token=…&refresh_token=…&type=magiclink|invite|signup|recovery
 *     /#error=access_denied&error_code=otp_expired&error_description=…
 *     /?token_hash=…&type=…          (only if an email template is customised)
 *
 * The intended target is assets/html/sign-up.html, the set-password page.
 * But Supabase sends the student to the SITE URL — this page — instead
 * whenever the requested target is missing from the Redirect URLs allow list,
 * and invites sent from the Supabase dashboard always land here. This page
 * has no set-password UI, so such a link used to "do nothing": the SDK
 * quietly signed the student in and the landing page carried on as normal.
 *
 * So: when this URL carries an auth result, hand all of it — query and hash,
 * untouched — to the set-password page, before anything paints and before
 * this page's own Supabase client can spend the one-time tokens.
 * ==========================================================================*/
(function () {
    'use strict';

    var hash = new URLSearchParams(window.location.hash.replace(/^#/, ''));
    var query = new URLSearchParams(window.location.search);

    var isAuthResult =
        hash.has('access_token') ||
        hash.has('error_description') ||
        query.has('token_hash') ||
        query.has('error_description');

    if (!isAuthResult) { return; }

    /* Read by function.js: this page's client leaves the tokens alone. */
    window.PIA_AUTH_FORWARDING = true;

    /* Nothing of the landing page flashes up while the next page loads. */
    document.documentElement.style.visibility = 'hidden';

    window.location.replace('assets/html/sign-up.html' + window.location.search + window.location.hash);
})();
