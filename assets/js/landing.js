/**
 * ============================================================================
 * PIA SYSTEM — LANDING SCROLL NARRATIVE
 * ============================================================================
 * Presentation only. Nothing here touches auth, the database, or any element
 * auth.js owns — it can be removed and the page still signs people in.
 *
 * PERFORMANCE CONTRACT
 *   * No scroll event listener drives layout. Reveals, the nav state and the
 *     pinned sequence are all IntersectionObserver callbacks, which fire off
 *     the main thread's critical path and cost nothing per frame.
 *   * The one thing that must track scroll continuously — the hero's parallax
 *     — reads scrollY inside requestAnimationFrame and writes only a
 *     `transform`. Reading in rAF (never in the listener) avoids forcing a
 *     synchronous layout on every wheel tick.
 *   * Every property animated anywhere is `opacity` or `transform`. Neither
 *     triggers layout or paint, so none of this can produce layout shift and
 *     all of it stays on the compositor.
 * ==========================================================================*/
(function () {
    'use strict';

    var $ = function (s, r) { return (r || document).querySelector(s); };
    var $$ = function (s, r) { return Array.prototype.slice.call((r || document).querySelectorAll(s)); };

    var reduceMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches;

    /* ============================================ 1. REVEALS =========== */

    /* Elements lift into place once, when their top edge clears the lower
       quarter of the viewport. `once` semantics: an element that has arrived
       is never re-animated, so scrolling back up does not re-trigger a wave. */
    function initReveals() {
        var targets = $$('[data-reveal]');

        if (reduceMotion || !('IntersectionObserver' in window)) {
            targets.forEach(function (el) { el.classList.add('is-in', 'is-done'); });
            return;
        }

        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) { return; }
                var el = entry.target;
                el.classList.add('is-in');
                io.unobserve(el);

                /* Release the compositor layer once the transition finishes.
                   Leaving `will-change` on hundreds of nodes is itself a
                   performance problem — it holds GPU memory forever. */
                el.addEventListener('transitionend', function onDone(e) {
                    if (e.propertyName !== 'transform') { return; }
                    el.classList.add('is-done');
                    el.removeEventListener('transitionend', onDone);
                });
            });
        }, {
            /* Fire a little before the element is fully on screen so the
               motion reads as "already happening" rather than as a pop. */
            rootMargin: '0px 0px -12% 0px',
            threshold: 0.01
        });

        targets.forEach(function (el) { io.observe(el); });
    }

    /* ============================================ 2. NAV STATE ========= */

    /* A 1px sentinel at the top of the document. When it leaves the viewport
       the page has scrolled — no scroll listener, no per-frame work. */
    function initNav() {
        var nav = $('#site-nav');
        var sentinel = $('#nav-sentinel');
        if (!nav || !sentinel || !('IntersectionObserver' in window)) { return; }

        new IntersectionObserver(function (entries) {
            nav.classList.toggle('is-stuck', !entries[0].isIntersecting);
        }, { threshold: 0 }).observe(sentinel);
    }

    /* ============================================ 3. SEQUENCE ========== */

    /* The stage is pinned by CSS `position: sticky`; this only decides which
       of its stacked layers is opaque. A narrow horizontal band across the
       middle of the viewport acts as the playhead: whichever step is crossing
       it owns the stage. */
    /* ============================================ 4. HERO PARALLAX ===== */

    /* The only scroll-linked effect. scrollY is read inside rAF rather than in
       the listener, so a fast wheel cannot force a layout flush per event; the
       listener does nothing but set a flag. */
    /* ============================================ 5. COUNTERS ========== */

    /* Counts up when the number scrolls into view. The value's box is fixed by
       `min-width: 4ch` plus tabular figures in the stylesheet, so the digits
       can change every frame without moving anything around them. */
    function initCounters() {
        var nodes = $$('[data-count]');
        if (!nodes.length) { return; }

        if (reduceMotion || !('IntersectionObserver' in window)) {
            nodes.forEach(function (n) { n.textContent = n.getAttribute('data-count'); });
            return;
        }

        var io = new IntersectionObserver(function (entries) {
            entries.forEach(function (entry) {
                if (!entry.isIntersecting) { return; }
                var node = entry.target;
                io.unobserve(node);

                var target = Number(node.getAttribute('data-count')) || 0;
                var start = performance.now();
                var DURATION = 900;

                function tick(now) {
                    var t = Math.min(1, (now - start) / DURATION);
                    /* ease-out cubic: fast start, gentle landing */
                    var eased = 1 - Math.pow(1 - t, 3);
                    node.textContent = String(Math.round(target * eased));
                    if (t < 1) { requestAnimationFrame(tick); }
                }

                requestAnimationFrame(tick);
            });
        }, { threshold: 0.5 });

        nodes.forEach(function (n) { io.observe(n); });
    }

    /* ============================================ 6. BOOT ============== */

    /* ============================================ 3. THEME =========== */

    /* Three states, deliberately: an explicit choice stored in localStorage
       always wins; with no choice stored the page follows the operating
       system. The inline script in <head> applies the stored value before
       first paint, so there is never a flash of the wrong theme. */
    function initTheme() {
        var toggle = $('#theme-toggle');
        if (!toggle) { return; }

        function current() {
            /* The inline boot script always stamps an explicit value, so this
               is a straight read rather than a guess. */
            return document.documentElement.getAttribute('data-theme') || 'dark';
        }

        toggle.addEventListener('click', function () {
            var next = current() === 'dark' ? 'light' : 'dark';
            document.documentElement.setAttribute('data-theme', next);
            try { localStorage.setItem('pia_theme', next); } catch (e) { /* ignore */ }
            toggle.setAttribute('aria-pressed', String(next === 'dark'));
        });

        toggle.setAttribute('aria-pressed', String(current() === 'dark'));
    }

    /* ============================================ 4. CHARACTER SWITCHER ==
       Pure presentation for now: it moves the selection and announces the
       name. When the 3D model arrives, swap the body of showCharacter() for
       whatever loads it — the layout is already locked by the figure's
       aspect-ratio, so nothing here can shift. */
    function initSwitcher() {
        var dots = $$('.switch-dot');
        var name = $('#char-name');
        var prev = $('#char-prev');
        var next = $('#char-next');
        if (!dots.length || !name) { return; }

        /* Placeholder copy. Kept to a similar length on purpose: the
           description block reserves three lines, so swapping characters
           does not move the buttons underneath it. */
        var CHARACTERS = [
            {
                name: 'Calm Kai',
                desc: 'Kai takes it one step at a time and never rushes you. Ask for a ' +
                      'hint as often as you like — there is no timer and nothing here ' +
                      'counts towards a grade.'
            },
            {
                name: 'Zippy Theo',
                desc: 'Theo moves quickly and keeps things short. Expect brisk questions, ' +
                      'quick checks and a nudge onwards the moment a topic clicks into ' +
                      'place for you.'
            },
            {
                name: 'Kind Amy',
                desc: 'Amy explains the why before the how, and will happily go back over ' +
                      'anything twice. Nothing is a silly question and no answer is ever ' +
                      'marked wrong.'
            }
        ];

        var desc = $('#char-desc');
        var index = 0;

        function showCharacter(i) {
            index = (i + dots.length) % dots.length;
            dots.forEach(function (d, n) { d.setAttribute('aria-current', String(n === index)); });
            var c = CHARACTERS[index] || { name: '', desc: '' };
            name.textContent = c.name;
            if (desc) { desc.textContent = c.desc; }
        }

        dots.forEach(function (d) {
            d.addEventListener('click', function () { showCharacter(Number(d.getAttribute('data-char'))); });
        });
        if (prev) { prev.addEventListener('click', function () { showCharacter(index - 1); }); }
        if (next) { next.addEventListener('click', function () { showCharacter(index + 1); }); }

        /* Arrow keys move the selection when focus is inside the group. */
        var group = $('.hero-switcher');
        if (group) {
            group.addEventListener('keydown', function (e) {
                if (e.key === 'ArrowLeft') { e.preventDefault(); showCharacter(index - 1); }
                if (e.key === 'ArrowRight') { e.preventDefault(); showCharacter(index + 1); }
            });
        }

        showCharacter(0);
    }

    /* ============================================ 5. 3D MODEL =========
       auto-rotate is continuous motion, so it has to answer to the same
       reduced-motion preference as everything else on the page. The attribute
       is removed rather than paused, so no animation frame is scheduled at
       all. */
    function initModel() {
        var mv = $('#hero-model');
        if (!mv) { return; }

        if (window.matchMedia('(prefers-reduced-motion: reduce)').matches) {
            mv.removeAttribute('auto-rotate');
        }

        /* model-viewer has no "error" slot, so the fallback is a sibling we
           reveal by hand. Without this a 404 on the .glb leaves the poster
           up forever and the hero reads as permanently loading. */
        var fallback = $('#hero-fallback');

        mv.addEventListener('error', function (e) {
            console.error('3D model failed to load:', mv.getAttribute('src'), e.detail || e);
            if (!fallback) { return; }
            fallback.hidden = false;
            /* Keep the box; just stop the dead viewer showing through. */
            mv.style.visibility = 'hidden';
        });

        mv.addEventListener('load', function () {
            if (fallback) { fallback.hidden = true; }
            mv.style.visibility = '';
        });
    }

    function boot() {
        initTheme();
        initModel();
        initSwitcher();
        initReveals();
        initNav();
        initCounters();
    }

    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', boot);
    } else {
        boot();
    }
})();
