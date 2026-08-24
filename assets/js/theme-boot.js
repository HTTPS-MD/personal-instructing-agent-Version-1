/**
 * ============================================================================
 * PIA SYSTEM — PRE-PAINT BOOT
 * ============================================================================
 * Loaded from <head> WITHOUT defer or async, so it runs before the body is
 * parsed and therefore before the first paint. That timing is the whole point:
 *
 *   1. A light-mode visitor must never see a dark flash. The theme has to be
 *      on <html> before anything is painted, which rules out doing this from
 *      a deferred script or on DOMContentLoaded.
 *   2. `.js` gates the scroll-reveal targets' hidden state in landing.css.
 *      Stamping it here means a browser with JS disabled — or a page whose
 *      scripts fail to load — renders every reveal target VISIBLE rather than
 *      permanently at opacity 0, i.e. a blank page.
 *
 * WHY THIS IS A FILE AND NOT AN INLINE <script>
 * Inline is the textbook answer, and it was inline first. But the page ships
 * a strict Content-Security-Policy, and pinning an inline script means
 * pinning a sha256 of its exact bytes — which this repo's HTML formatter
 * silently invalidates by re-indenting the file. A same-origin file is
 * covered by script-src 'self', needs no hash, and cannot rot. The cost is
 * one small cached request before paint.
 *
 * Keep this file tiny and dependency-free. It is on the critical path.
 * ==========================================================================*/
(function () {
    'use strict';

    var theme = 'dark';

    try {
        var saved = localStorage.getItem('pia_theme');
        if (saved === 'light' || saved === 'dark') {
            /* An explicit choice always beats the operating system. */
            theme = saved;
        } else if (window.matchMedia('(prefers-color-scheme: light)').matches) {
            theme = 'light';
        }
    } catch (e) {
        /* Private mode with storage disabled — fall through to the default. */
    }

    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.add('js');

    /* Promote the webfont preload to a real stylesheet.
       ------------------------------------------------------------------
       The fonts are requested as rel="preload" in the document head so they
       cannot render-block, and cannot block the body scripts behind them —
       see the comment on that element. They are only useful once they are an
       actual stylesheet, which is what this does.

       Two triggers, because one is not enough: the link's own load event is
       the fast path, and window.load is the backstop for the case where the
       preload finished before this listener was attached. Setting rel twice
       is a no-op, and by window.load nothing is left to block anyway.

       If the request never resolves the page simply keeps its fallback
       stack, which is metrics-matched to Inter — no layout shift, no blank
       text, no stalled sign-in. */
    var fontCss = document.getElementById('font-css');

    if (fontCss) {
        var promote = function () { fontCss.rel = 'stylesheet'; };
        fontCss.addEventListener('load', promote);
        window.addEventListener('load', promote);
    }
})();
