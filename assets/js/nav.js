/** Landing navigation. Account actions use full button geometry, the sticky
 * header, visual viewport and hit testing. Updates are coalesced per frame.
 * Hidden copies retain their space and are inert; focused actions stay visible.
 */
(function () {
    'use strict';

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

    /* Must match the 64rem breakpoint in landing.css sections 4.6, 12 and 30. */
    var DESKTOP = window.matchMedia('(min-width: 64rem)');

    function boot() {
        var nav = $('#nav');
        if (!nav) { return; }

        initSurface(nav);
        initAuthSwap(nav);
        initSheet(nav);
        initScrollspy(nav);
    }


    /* ==================================================================== *
     * 1B. JOIN — ONE PLACE AT A TIME                                       *
     * ==================================================================== *
     * The hero carries the student-number field, so while it is on screen the
     * bar's own Join stands down (CSS hides .nav-auth unless the bar has
     * .has-auth). Once the field has left the visible area below the bar —
     * scrolled up under it, or never in view on a very short screen — Join
     * comes back, so the way in is always one tap away and never shown
     * twice. Teacher / Admin is not managed here: it is always in the bar.  */

    function initAuthSwap(nav) {
        var hero = $('#hero-cta');
        var controls = $$('.nav-auth', nav);
        var queued = false;
        function update() {
            queued = false;
            var top = nav.getBoundingClientRect().bottom;
            var viewport = window.visualViewport;
            var bottom = viewport ? viewport.offsetTop + viewport.height : window.innerHeight;
            var rect = hero ? hero.getBoundingClientRect() : null;
            /* The hero's field (or, signed in, its Continue button) counts as on screen
               while it is still mostly below the bar and above the bottom edge. */
            var visible = !!rect && rect.height > 0 && rect.bottom > top + 12 && rect.top < bottom - 12;
            var show = !visible || controls.some(function (button) {
                return button.contains(document.activeElement);
            });
            if (nav.classList.contains('has-auth') !== show) { nav.classList.toggle('has-auth', show); }
            controls.forEach(function (button) {
                button.inert = !show;
                button.setAttribute('aria-hidden', String(!show));
            });
        }
        function schedule() {
            if (!queued) { queued = true; requestAnimationFrame(update); }
        }
        window.addEventListener('scroll', schedule, { passive: true });
        window.addEventListener('resize', schedule, { passive: true });
        nav.addEventListener('focusout', schedule);
        if (window.visualViewport) {
            window.visualViewport.addEventListener('resize', schedule);
            window.visualViewport.addEventListener('scroll', schedule);
        }
        if ('ResizeObserver' in window) {
            var size = new ResizeObserver(schedule);
            size.observe(nav);
            if (hero) { size.observe(hero); }
        }
        new MutationObserver(schedule).observe(nav, { attributes: true, attributeFilter: ['class'] });
        new MutationObserver(schedule).observe(document.documentElement, { attributes: true, attributeFilter: ['data-session'] });
        update();
    }


    /* ==================================================================== *
     * 1. SURFACE                                                           *
     * ==================================================================== *
     * No background at the very top of the page, where the hero picture is
     * under the bar; solid as soon as the page has scrolled, so the links never
     * sit on top of the copy sliding by. A plain scroll check rather than an
     * observer, so it behaves the same in every browser and when the file is
     * opened straight from disk.                                             */

    function initSurface(nav) {
        var queued = false;

        function update() {
            queued = false;
            nav.classList.toggle('is-solid', (window.scrollY || window.pageYOffset || 0) > 24);
        }

        window.addEventListener('scroll', function () {
            if (queued) { return; }
            queued = true;
            requestAnimationFrame(update);
        }, { passive: true });

        update();
    }


    /* ==================================================================== *
     * 2. SHEET                                                             *
     * ==================================================================== *
     * A disclosure (button + aria-expanded + aria-controls), which is the
     * WAI-ARIA pattern for site navigation — NOT role="menu", which promises
     * arrow-key application-menu behaviour that a list of links should not
     * pretend to have.                                                       */

    function initSheet(nav) {
        var burger = $('#nav-burger');
        var sheet = $('#nav-menu');
        var scrim = $('#nav-scrim');
        if (!burger || !sheet) { return; }

        function isOpen() { return nav.classList.contains('is-open'); }

        /* The same lock auth.js uses for dialogs — class, measured gutter
           substituted as padding — so opening the sheet cannot shift the page
           sideways on a desktop browser with classic scrollbars. It only
           releases the lock when no dialog is mounted, because a sign-in
           button in the sheet closes the sheet and opens a dialog in the same
           click, and the dialog must keep the page locked. */
        function lockScroll() {
            var gap = window.innerWidth - document.documentElement.clientWidth;
            document.documentElement.style.setProperty('--scrollbar-w', gap + 'px');
            document.body.classList.add('is-locked');
        }

        function unlockScroll() {
            if ($('.overlay.is-mounted')) { return; }
            document.body.classList.remove('is-locked');
            document.documentElement.style.setProperty('--scrollbar-w', '0px');
        }

        function setOpen(open, returnFocus) {
            if (open === isOpen()) { return; }

            nav.classList.toggle('is-open', open);
            burger.setAttribute('aria-expanded', String(open));
            if (scrim) { scrim.classList.toggle('is-open', open); }

            if (open) {
                lockScroll();
                /* Into the sheet, so Tab walks the links next. After a mouse
                   or touch activation this does not draw a focus ring —
                   :focus-visible follows the modality that opened it. */
                var first = $('.nav-link', sheet);
                if (first) { first.focus({ preventScroll: true }); }
            } else {
                unlockScroll();
                if (returnFocus) { burger.focus({ preventScroll: true }); }
            }
        }

        burger.addEventListener('click', function () { setOpen(!isOpen()); });

        /* CAPTURE phase, on the whole bar. It must run BEFORE the target's own
           listeners: auth.js smooth-scrolls in-page links and opens dialogs
           from the target, and both need the page unlocked (or re-locked by
           the dialog) by the time they act. Matches section links, the
           wordmark, and every sign-in / activate button — in the sheet or in
           the bar. The theme toggle is deliberately NOT matched: flipping the
           theme is something you want to watch happen. */
        nav.addEventListener('click', function (event) {
            if (!isOpen()) { return; }
            if (event.target.closest('a[href^="#"], [data-auth-open]')) { setOpen(false); }
        }, true);

        if (scrim) {
            scrim.addEventListener('click', function () { setOpen(false); });
        }

        document.addEventListener('keydown', function (event) {
            if (event.key === 'Escape' && isOpen()) { setOpen(false, true); }
        });

        /* Tabbing out of the bar closes the sheet behind you. Only when focus
           verifiably went somewhere ELSE: a tap on a non-focusable part of
           the sheet (its padding, a group label) also blurs, with a null
           relatedTarget, and must not slam it shut. Taps outside are the
           scrim's job. */
        nav.addEventListener('focusout', function (event) {
            var next = event.relatedTarget;
            if (isOpen() && next && !nav.contains(next)) { setOpen(false); }
        });

        /* Rotating a tablet, or dragging a window wider, past the breakpoint
           turns the sheet back into the inline bar — which has no open state
           to be stuck in. */
        var onBreakpoint = function (event) { if (event.matches) { setOpen(false); } };
        if (DESKTOP.addEventListener) { DESKTOP.addEventListener('change', onBreakpoint); }
        else if (DESKTOP.addListener) { DESKTOP.addListener(onBreakpoint); }

        /* Section links move FOCUS as well as the viewport. auth.js's smooth
           scroll moves only the viewport, which leaves a keyboard user's next
           Tab starting from the navbar again. tabindex="-1" makes the section
           focusable by script without adding it to the tab order; the
           timeout lets the click's own handlers (the smooth scroll, or the
           browser's native jump) run first. */
        $$('.nav-link', sheet).forEach(function (link) {
            link.addEventListener('click', function () {
                var target = document.getElementById(link.getAttribute('href').slice(1));
                if (!target) { return; }
                if (!target.hasAttribute('tabindex')) { target.setAttribute('tabindex', '-1'); }
                setTimeout(function () { target.focus({ preventScroll: true }); }, 0);
            });
        });
    }


    /* ==================================================================== *
     * 3. SCROLLSPY                                                         *
     * ==================================================================== *
     * The root is a 1%-tall band just above the middle of the viewport; the
     * section crossing it is "current". Over the hero nothing is current,
     * which is correct — the hero is not in the menu.                        */

    function initScrollspy(nav) {
        if (!('IntersectionObserver' in window)) { return; }

        var bySection = {};
        $$('.nav-link[href^="#"]', nav).forEach(function (link) {
            var section = document.getElementById(link.getAttribute('href').slice(1));
            if (section) { bySection[section.id] = { link: link, section: section }; }
        });

        var ids = Object.keys(bySection);
        if (!ids.length) { return; }

        var current = null;

        function setCurrent(id) {
            if (id === current) { return; }
            if (current && bySection[current]) { bySection[current].link.removeAttribute('aria-current'); }
            current = id;
            if (id && bySection[id]) { bySection[id].link.setAttribute('aria-current', 'location'); }
        }

        var spy = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (entry.isIntersecting) { setCurrent(entry.target.id); }
                else if (current === entry.target.id) { setCurrent(null); }
            });
        }, { rootMargin: '-45% 0px -54% 0px' });

        ids.forEach(function (id) { spy.observe(bySection[id].section); });
    }


    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
