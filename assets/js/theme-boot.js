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

    /* Dark is the default: the brand is ink with neon on it, and light mode
       is the same page printed on newsprint. A stored choice from the toggle
       always wins. The OS preference is deliberately not consulted — most
       machines report "light" simply because nobody changed it, which would
       make the alternate the page almost everyone sees. */
    var theme = 'dark';

    try {
        var saved = localStorage.getItem('pia_theme');
        if (saved === 'light' || saved === 'dark') { theme = saved; }
    } catch (e) {
        /* Private mode with storage disabled — fall through to the default. */
    }

    document.documentElement.setAttribute('data-theme', theme);
    document.documentElement.classList.add('js');

    /* A signed-in visitor, guessed before paint. supabase-js keeps the
       session in localStorage as sb-<project>-auth-token. The landing page
       reads this to greet the visitor instead of pitching to them — it hides
       "Activate account", and holds the headline back so the default title
       never flashes before the greeting. auth.js then confirms the guess
       (data-session="in") or withdraws it. A hint for presentation only:
       nothing is unlocked on its strength, every page still checks the
       session itself. */
    try {
        for (var i = 0; i < localStorage.length; i++) {
            if (/^sb-.+-auth-token$/.test(localStorage.key(i) || '')) {
                document.documentElement.setAttribute('data-session', 'pending');
                break;
            }
        }
    } catch (e) {
        /* Storage blocked — the page simply starts signed out. */
    }

    /* ── WEBFONTS ─────────────────────────────────────────────────────────
       THE ONE PLACE A FONT FILE IS NAMED. To change a typeface, edit this
       URL and the matching --font-display / --font-body / --font-mono tokens
       in styles/global.css (section C of the :root block). Every page runs
       this file, so no HTML needs touching.

       The stylesheet is requested as rel="preload" so it can never
       render-block — or block the body scripts, i.e. sign-in — on a network
       where the font host is slow or filtered. It becomes a real stylesheet
       once it has arrived. Until then the text uses the metrics-matched
       stand-ins in global.css, so nothing moves when the fonts land.

       Two promotion triggers, because one is not enough: the link's own
       load event is the fast path, and window.load is the backstop for a
       preload that finished before the listener was attached. Setting rel
       twice is a no-op. If the request never resolves, the page simply keeps
       its stand-ins. */
    var FONT_STYLESHEET = 'https://fonts.googleapis.com/css2' +
        '?family=Inter:wght@400;500;600;700;800' +
        '&family=JetBrains+Mono:wght@500;700' +
        '&family=Space+Grotesk:wght@700' +
        '&display=swap';

    /* The hosts the fonts come from, warmed up before the request. The font
       FILES are fetched with CORS, so their host's connection must be too;
       the stylesheet host's must not, or the warm connection goes unused.
       Update these if the fonts move (self-hosted files: drop them). */
    var FONT_ORIGINS = [
        { href: 'https://fonts.googleapis.com', cors: false },
        { href: 'https://fonts.gstatic.com', cors: true }
    ];

    var head = document.head || document.getElementsByTagName('head')[0];

    FONT_ORIGINS.forEach(function (origin) {
        var hint = document.createElement('link');
        hint.rel = 'preconnect';
        hint.href = origin.href;
        if (origin.cors) { hint.crossOrigin = ''; }
        head.appendChild(hint);
    });

    var fontCss = document.createElement('link');
    fontCss.id = 'font-css';
    fontCss.rel = 'preload';
    fontCss.as = 'style';
    fontCss.href = FONT_STYLESHEET;

    var promote = function () { fontCss.rel = 'stylesheet'; };
    fontCss.addEventListener('load', promote);
    window.addEventListener('load', promote);
    head.appendChild(fontCss);
})();
