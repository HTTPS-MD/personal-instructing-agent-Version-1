/**
 * Admin console webfonts: Inter (UI text) and JetBrains Mono (numbers, timers,
 * identifiers). Requested like theme-boot.js requests the site fonts: as a
 * preload that is promoted to a stylesheet when it arrives, so a slow or
 * filtered font host can never block the page or sign-in. Until the files
 * land the metric-matched stand-ins from global.css are used.
 *
 * A file rather than an inline <script> because the site's
 * Content-Security-Policy forbids inline script (see _headers).
 */
(function () {
    'use strict';
    var URLS = [
        'https://fonts.googleapis.com/css2?family=Inter:wght@400;500;600&display=swap',
        'https://fonts.googleapis.com/css2?family=JetBrains+Mono:wght@400;500&display=swap'
    ];
    var head = document.head || document.getElementsByTagName('head')[0];
    URLS.forEach(function (href, i) {
        var link = document.createElement('link');
        link.id = 'admin-font-css-' + i;
        link.rel = 'preload';
        link.as = 'style';
        link.href = href;
        var promote = function () { link.rel = 'stylesheet'; };
        link.addEventListener('load', promote);
        window.addEventListener('load', promote);
        head.appendChild(link);
    });
})();
